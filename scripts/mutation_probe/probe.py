"""Mutation probe: inject one small realistic bug at a time and see if the tests notice.

Usage and how to read the result: docs/MUTATION_PROBE.md.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

HERE = Path(__file__).resolve().parent
DEFAULT_LIST = HERE / "mutations.toml"


class DirtyTree(Exception):
    """The checkout has local changes; the probe only runs on a clean tree."""


class BaselineFailed(Exception):
    """The selected tests fail before any mutation; every verdict would be meaningless."""

    def __init__(self, suite: str, outcome: "Outcome"):
        super().__init__(
            f"{suite} tests fail without any mutation ({outcome.summary}): "
            + ", ".join(outcome.failures[:5])
        )
        self.suite = suite
        self.outcome = outcome


@dataclass(frozen=True)
class Mutation:
    id: str
    suite: str
    file: str
    find: str
    replace: str
    breaks: str
    tests: tuple[str, ...]
    spec: int | None = None
    audit: str = ""


@dataclass(frozen=True)
class Outcome:
    returncode: int
    failures: list[str] = field(default_factory=list)
    summary: str = ""


RunTests = Callable[[str, Sequence[str]], Outcome]

SUITES = ("sidecar", "renderer")
REQUIRED = ("id", "suite", "file", "find", "replace", "breaks", "tests")


class BadMutationList(Exception):
    """The mutation list cannot be used as written."""


def _expand_tests(entry_id: str, raw: list[str], groups: dict, root: Path) -> tuple[str, ...]:
    out: list[str] = []
    for item in raw:
        if item.startswith("@"):
            if item[1:] not in groups:
                raise BadMutationList(f"{entry_id}: unknown test group {item}")
            out.extend(_expand_tests(entry_id, groups[item[1:]], groups, root))
        elif any(ch in item for ch in "*?["):
            matches = sorted(p.relative_to(root).as_posix() for p in root.glob(item))
            if not matches:
                raise BadMutationList(f"{entry_id}: no test file matches {item}")
            out.extend(matches)
        else:
            if not (root / item).is_file():
                raise BadMutationList(f"{entry_id}: test file {item} does not exist")
            out.append(item)
    return tuple(dict.fromkeys(out))


def load_mutations(list_path: Path, root: Path) -> list[Mutation]:
    with open(list_path, "rb") as fh:
        data = tomllib.load(fh)
    groups = data.get("groups", {})
    seen: set[str] = set()
    mutations = []
    for entry in data.get("mutation", []):
        entry_id = entry.get("id", "<no id>")
        # replace may be empty (a mutation that deletes its find text)
        missing = [k for k in REQUIRED if k not in entry or (k != "replace" and not entry[k])]
        if missing:
            raise BadMutationList(f"{entry_id}: missing {', '.join(missing)}")
        if entry_id in seen:
            raise BadMutationList(f"{entry_id}: id used twice")
        seen.add(entry_id)
        if entry["suite"] not in SUITES:
            raise BadMutationList(f"{entry_id}: suite must be one of {SUITES}, not {entry['suite']}")
        mutations.append(
            Mutation(
                id=entry_id,
                suite=entry["suite"],
                file=entry["file"],
                find=entry["find"],
                replace=entry["replace"],
                breaks=" ".join(entry["breaks"].split()),
                tests=_expand_tests(entry_id, entry["tests"], groups, root),
                spec=entry.get("spec"),
                audit=entry.get("audit", ""),
            )
        )
    return mutations


def git_status(root: Path) -> str:
    return subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def require_clean(root: Path) -> None:
    status = git_status(root)
    if status.strip():
        raise DirtyTree(
            "the checkout has local changes; commit or remove them first:\n" + status
        )


@dataclass(frozen=True)
class Result:
    mutation: Mutation
    status: str  # killed | survived | error | stale
    failures: list[str] = field(default_factory=list)
    summary: str = ""


def _status(outcome: Outcome) -> str:
    if outcome.returncode == 0:
        return "survived"
    if outcome.returncode == 1:
        return "killed"
    return "error"


def _encode(text: str, crlf: bool) -> bytes:
    return (text.replace("\n", "\r\n") if crlf else text).encode("utf-8")


def anchor_count(root: Path, m: Mutation) -> int:
    path = root / m.file
    if not path.is_file():
        return 0
    data = path.read_bytes()
    return data.count(_encode(m.find, b"\r\n" in data))


def _apply_and_run(root: Path, m: Mutation, run_tests: RunTests) -> Result:
    if anchor_count(root, m) != 1:
        return Result(m, "stale", summary=f"find text matches {anchor_count(root, m)} times in {m.file}")
    path = root / m.file
    original = path.read_bytes()
    crlf = b"\r\n" in original
    try:
        path.write_bytes(original.replace(_encode(m.find, crlf), _encode(m.replace, crlf), 1))
        outcome = run_tests(m.suite, m.tests)
    finally:
        path.write_bytes(original)
        if path.read_bytes() != original:  # pragma: no cover - disk trouble
            raise RuntimeError(f"could not restore {m.file}; run `git checkout -- {m.file}`")
    return Result(m, _status(outcome), list(outcome.failures), outcome.summary)


def run_probe(
    root: Path,
    mutations: Sequence[Mutation],
    run_tests: RunTests,
    on_result: Callable[[Result], None] | None = None,
) -> list[Result]:
    """Apply each mutation alone, run its tests, put the source back.

    Refuses a dirty tree up front and before every mutation, so a second
    run (or a person editing) in the same checkout stops this one instead
    of mixing two mutations. The source is restored on every exit path,
    exceptions and Ctrl+C included.
    """
    require_clean(root)
    for suite in dict.fromkeys(m.suite for m in mutations):
        tests = list(dict.fromkeys(t for m in mutations if m.suite == suite for t in m.tests))
        outcome = run_tests(suite, tests)
        if outcome.returncode != 0:
            raise BaselineFailed(suite, outcome)
    results = []
    for m in mutations:
        require_clean(root)
        result = _apply_and_run(root, m, run_tests)
        results.append(result)
        if on_result:
            on_result(result)
    return results


# ---------------------------------------------------------------- report


def area(m: Mutation) -> str:
    return m.id.rstrip("0123456789")


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def render_report(results: Sequence[Result], header: str = "") -> str:
    lines = ["# Mutation probe result", ""]
    if header:
        lines += [header, ""]
    lines += ["| Area | Killed | Survived | Other |", "| --- | --- | --- | --- |"]
    for a in dict.fromkeys(area(r.mutation) for r in results):
        rows = [r for r in results if area(r.mutation) == a]
        killed = sum(r.status == "killed" for r in rows)
        survived = sum(r.status == "survived" for r in rows)
        lines.append(f"| {a} | {killed} of {len(rows)} | {survived} | {len(rows) - killed - survived} |")
    lines += [
        "",
        "## Every mutation",
        "",
        "| ID | Breaks | Audit | Now | First test that caught it |",
        "| --- | --- | --- | --- | --- |",
    ]
    for r in results:
        caught = r.failures[0] if r.failures else ("" if r.status == "survived" else r.summary)
        lines.append(
            f"| {r.mutation.id} | {_cell(r.mutation.breaks)} | {r.mutation.audit or '-'} "
            f"| {r.status} | {_cell(caught)} |"
        )
    lines += ["", "## Survivors", ""]
    survivors = [r for r in results if r.status != "killed"]
    if not survivors:
        lines.append("None.")
    else:
        lines += ["| ID | Breaks | Status | Spec expected to kill it |", "| --- | --- | --- | --- |"]
        for r in survivors:
            spec = f"#{r.mutation.spec}" if r.mutation.spec else "unassigned"
            lines.append(f"| {r.mutation.id} | {_cell(r.mutation.breaks)} | {r.status} | {spec} |")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------- runners


def _pytest_runner(root: Path, python: str, whole_suite: bool):
    def run(tests: Sequence[str]) -> Outcome:
        args = [python, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider", "-rfE"]
        if not whole_suite:
            args += [t.removeprefix("sidecar/") for t in tests]
        proc = subprocess.run(
            args, cwd=root / "sidecar", capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
        out = proc.stdout + proc.stderr
        failures = list(dict.fromkeys(re.findall(r"^(?:FAILED|ERROR) (\S+)", out, re.M)))
        summary = [ln for ln in out.splitlines() if re.search(r"\d+ (passed|failed|error)", ln)]
        return Outcome(proc.returncode, failures, summary[-1].strip("= ") if summary else out[-300:])

    return run


def _vitest_runner(root: Path, whole_suite: bool):
    npx = shutil.which("npx") or "npx"

    def run(tests: Sequence[str]) -> Outcome:
        with tempfile.TemporaryDirectory(prefix="mutation-probe-") as tmp:
            report = Path(tmp) / "vitest.json"
            args = [npx, "vitest", "run", "--reporter=json", f"--outputFile={report}"]
            if not whole_suite:
                args += list(tests)
            proc = subprocess.run(
                args, cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace"
            )
            if not report.is_file():
                return Outcome(proc.returncode or 2, [], (proc.stdout + proc.stderr)[-300:])
            data = json.loads(report.read_text(encoding="utf-8"))
        failures = []
        for f in data.get("testResults", []):
            name = Path(f["name"]).resolve().relative_to(root.resolve()).as_posix()
            for a in f.get("assertionResults", []):
                if a.get("status") == "failed":
                    failures.append(f"{name} > {a.get('fullName') or a.get('title')}")
            if f.get("status") == "failed" and not f.get("assertionResults"):
                failures.append(f"{name} > (file failed to load)")
        summary = f"{data.get('numFailedTests', 0)} failed, {data.get('numPassedTests', 0)} passed"
        code = proc.returncode if proc.returncode in (0, 1) else 2
        return Outcome(code, failures, summary)

    return run


def default_python(root: Path) -> str:
    if os.environ.get("PROBE_PYTHON"):
        return os.environ["PROBE_PYTHON"]
    for rel in ("sidecar/.venv/Scripts/python.exe", "sidecar/.venv/bin/python"):
        if (root / rel).is_file():
            return str(root / rel)
    return sys.executable


def make_runner(root: Path, python: str, whole_suite: bool = False) -> RunTests:
    runners = {
        "sidecar": _pytest_runner(root, python, whole_suite),
        "renderer": _vitest_runner(root, whole_suite),
    }
    return lambda suite, tests: runners[suite](tests)


# ------------------------------------------------------------------- CLI


class _Stop(KeyboardInterrupt):
    """Raised from SIGTERM / SIGBREAK so the restoring `finally` blocks run."""


def _raise_stop(signum, _frame):
    raise _Stop(f"signal {signum}")


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True).stdout.strip()


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Inject one mutation at a time and see if the tests catch it.")
    ap.add_argument("--root", type=Path, default=HERE.parents[1], help="repository checkout to mutate")
    ap.add_argument("--list", type=Path, default=DEFAULT_LIST, help="mutation list (TOML)")
    ap.add_argument("--only", nargs="+", metavar="ID", help="run only these mutation ids, or area prefixes (A, L, R)")
    ap.add_argument("--suite", choices=SUITES, help="run only mutations of this suite")
    ap.add_argument("--python", help="python with the sidecar's test dependencies (default: sidecar/.venv, or $PROBE_PYTHON)")
    ap.add_argument("--whole-suite", action="store_true", help="run the whole suite for every mutation, not its listed tests")
    ap.add_argument("--check", action="store_true", help="only check that every mutation's find text matches exactly once")
    ap.add_argument("--report", type=Path, help="write a Markdown report here")
    args = ap.parse_args(argv)
    # Test titles can hold characters a Windows console code page lacks.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    root = args.root.resolve()
    try:
        mutations = load_mutations(args.list, root)
    except BadMutationList as exc:
        print(f"mutation list: {exc}", file=sys.stderr)
        return 2
    if args.only:
        wanted = set(args.only)
        mutations = [m for m in mutations if m.id in wanted or area(m) in wanted]
    if args.suite:
        mutations = [m for m in mutations if m.suite == args.suite]

    if args.check:
        stale = [(m, anchor_count(root, m)) for m in mutations if anchor_count(root, m) != 1]
        for m, n in stale:
            print(f"{m.id}: find text matches {n} times in {m.file}")
        print(f"{len(mutations) - len(stale)} of {len(mutations)} mutations apply cleanly")
        return 1 if stale else 0

    for name in ("SIGTERM", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), _raise_stop)

    def show(r: Result) -> None:
        detail = r.failures[0] if r.failures else r.summary
        print(f"{r.mutation.id:<4} {r.status.upper():<8} {r.mutation.breaks[:70]}  [{detail}]", flush=True)

    runner = make_runner(root, args.python or default_python(root), args.whole_suite)
    try:
        results = run_probe(root, mutations, runner, on_result=show)
    except (DirtyTree, BaselineFailed) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("stopped; the source is restored", file=sys.stderr)
        return 130

    killed = sum(r.status == "killed" for r in results)
    print(f"\n{killed} of {len(results)} mutations killed")
    leftover = git_status(root)
    if leftover.strip():  # pragma: no cover - would mean a restore went wrong
        print(f"WARNING: the tree is not clean after the run:\n{leftover}", file=sys.stderr)
        return 3
    if args.report:
        header = (
            f"Commit `{_git(root, 'rev-parse', '--short', 'HEAD')}` on "
            f"`{_git(root, 'rev-parse', '--abbrev-ref', 'HEAD')}`, "
            f"{_dt.date.today().isoformat()}, "
            f"{'whole suites' if args.whole_suite else 'listed tests per mutation'}."
        )
        args.report.write_text(render_report(results, header), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
