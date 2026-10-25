"""The two product rules every data-touching test is held to.

- **log_unchanged**: a Log is F-Chat's; the app reads it in place and
  never changes it. Every file under `<FCHAT_DATA_DIR>/<character>/logs/`
  must be byte-identical after the test, none added, none removed.
- **nothing_vanishes**: nothing the user owns disappears except into
  the Trash or a Backup. The user owns every file under the data
  directory's `characters/` and `avatars/`. Each one that is gone after
  the test, and each one the app deleted along the way, must still be
  kept: its bytes in a file in some character's Trash, a member of a
  Backup zip (in a character's `backups/` or Trash), or a file still
  under the same character's folder (a move or rename within one
  character; for an avatar, still under `avatars/`). The same bytes in
  another character's folder do not count: that copy can be deleted
  on its own.

The `data_invariants` fixture is autouse. It applies to every test whose
`FLIST_WORKBENCH_DATA_DIR` or `FCHAT_DATA_DIR` points into pytest's temp
directory once its fixtures are set up. That is the moment the baseline
is taken, so what the fixtures put on disk is what the user owns. From
then on, every file the app deletes under the archive (`os.unlink`,
`os.remove`, `Path.unlink`, `shutil.rmtree` called from the sidecar's
source tree) is noted with its bytes, so a file the app writes and then
destroys within one test is caught too; files the test code deletes
itself are its own business. The check runs at teardown, after every
other fixture has finished (an app shutdown included), and fails the
test with the files it found.

A Log the test writes through `fchat_logs.write_log` is F-Chat's doing:
its new bytes become the ones that must not change.

Two markers, both naming a rule and a reason:

    @pytest.mark.invariant_exempt("nothing_vanishes", reason="a human empties the Trash")
        The rule is not checked for this test. Only for tests whose very
        subject is something the rule forbids, such as emptying the Trash.

    @pytest.mark.known_violation("nothing_vanishes", spec=2, reason="deleting a Backup is final")
        The product breaks the rule today and the named spec fixes it.
        Strict: once the violation stops, the test fails until the
        marker is removed, so the list stays true.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sys
import sysconfig
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import pytest

__all__ = [
    "LOG_UNCHANGED",
    "NOTHING_VANISHES",
    "data_invariants",
    "pytest_configure",
    "pytest_runtest_call",
]

LOG_UNCHANGED = "log_unchanged"
NOTHING_VANISHES = "nothing_vanishes"
RULES = (LOG_UNCHANGED, NOTHING_VANISHES)

#: What the user owns under the data directory: each character's Live,
#: Workbench, Backups, images, inlines and Trash, and the avatars.
ARCHIVE_DIRS = ("characters", "avatars")

#: A character's Trash and Backups, as `characters/<name>/<dir>/`.
TRASH_DIR = "trash"
BACKUPS_DIR = "backups"

#: Half-written files of an atomic write, never something the user owns.
_SCRATCH_SUFFIXES = (".tmp",)

TESTS_DIR = Path(__file__).resolve().parent

#: Code whose deletions are the app's: the sidecar's source tree. The
#: tests directory inside it is the test's own code.
APP_ROOTS: list[Path] = [TESTS_DIR.parent]


def _norm(path: str | Path) -> str:
    return os.path.normcase(os.path.realpath(path))


#: The interpreter's and the installed packages' code, looked through
#: when finding who asked for a deletion.
_LIB_ROOTS = tuple(
    {_norm(sysconfig.get_paths()[k]) for k in ("stdlib", "platstdlib", "purelib", "platlib")}
)
_THIS_FILE = _norm(__file__)


def _is_within(path: str | Path, *roots: str | Path) -> bool:
    """Whether `path` is one of `roots` or lies below one, compared after
    resolving links and (on Windows) case."""
    p = _norm(path)
    for root in roots:
        r = _norm(root)
        if p == r or p.startswith(r.rstrip(os.sep) + os.sep):
            return True
    return False


def _by_the_app(frame) -> bool:
    """Whether the nearest caller outside the standard library, the
    installed packages and this module is the app's code."""
    while frame is not None:
        name = frame.f_code.co_filename
        if not name.startswith("<"):
            f = _norm(name)
            if f != _THIS_FILE and not f.startswith(_LIB_ROOTS):
                return _is_within(f, *APP_ROOTS) and not _is_within(f, TESTS_DIR)
        frame = frame.f_back
    return False


def _sha256(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _walk(root: Path, *, skip: Path | None = None) -> dict[Path, str]:
    """Every regular file under `root` (absolute path -> sha256), leaving
    out the `skip` subtree and atomic-write scratch files."""
    out: dict[Path, str] = {}
    if not root.is_dir():
        return out
    skip_resolved = skip.resolve() if skip is not None else None
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        if skip_resolved is not None:
            dirnames[:] = [d for d in dirnames if (here / d).resolve() != skip_resolved]
        for name in filenames:
            if name.endswith(_SCRATCH_SUFFIXES):
                continue
            path = here / name
            digest = _sha256(path)
            if digest is not None:
                out[path] = digest
    return out


def _log_files(fchat_root: Path, *, skip: Path | None) -> dict[str, str]:
    """F-Chat keeps a character's Logs in `<root>/<character>/logs/`.
    Keyed by the path below `fchat_root`."""
    out: dict[str, str] = {}
    if not fchat_root.is_dir():
        return out
    for character in fchat_root.iterdir():
        logs = character / "logs"
        if logs.is_dir() and not (skip is not None and _is_within(character, skip)):
            for path, digest in _walk(logs, skip=skip).items():
                out[path.relative_to(fchat_root).as_posix()] = digest
    return out


def _home(path: str | Path, roots: list[Path]) -> str | None:
    """The folder a file may move or be renamed within and still count
    as kept: its character's folder under `characters/`, or `avatars/`
    itself. None for a file lying loose in `characters/`."""
    p = _norm(path)
    for root in roots:
        r = _norm(root)
        if not _is_within(p, r):
            continue
        if root.name != "characters":
            return r
        parts = Path(p).relative_to(r).parts
        return os.path.join(r, parts[0]) if len(parts) > 1 else None
    return None


def _zip_members(path: Path) -> set[str]:
    try:
        with zipfile.ZipFile(path) as z:
            return {
                hashlib.sha256(z.read(info)).hexdigest()
                for info in z.infolist()
                if not info.is_dir()
            }
    except (OSError, zipfile.BadZipFile):
        return set()


@dataclass
class _Kept:
    """Where the archive still holds a file's bytes after the test."""

    #: In any character's Trash, or a member of any Backup zip.
    anywhere: set[str] = field(default_factory=set)
    #: Home folder (see `_home`) -> the bytes of every file in it.
    by_home: dict[str, set[str]] = field(default_factory=dict)

    def holds(self, path: Path, digest: str, roots: list[Path]) -> bool:
        if digest in self.anywhere:
            return True
        home = _home(path, roots)
        return home is not None and digest in self.by_home.get(home, set())


def _kept(roots: list[Path]) -> _Kept:
    kept = _Kept()
    for root in roots:
        for path, digest in _walk(root).items():
            home = _home(path, roots)
            if home is not None:
                kept.by_home.setdefault(home, set()).add(digest)
            parts = path.relative_to(root).parts
            # characters/<name>/trash/... or characters/<name>/backups/...
            folder = parts[1] if root.name == "characters" and len(parts) > 2 else None
            if folder == TRASH_DIR:
                kept.anywhere.add(digest)
            if folder in (TRASH_DIR, BACKUPS_DIR) and path.suffix.lower() == ".zip":
                kept.anywhere |= _zip_members(path)
    return kept


@dataclass
class DataInvariants:
    """What the fixture yields. Tests rarely need it; the check is
    automatic."""

    basetemp: Path
    exempt: set[str] = field(default_factory=set)
    known: dict[str, int] = field(default_factory=dict)
    recorded: bool = False
    call_passed: bool = False
    fchat_root: Path | None = None
    archive_roots: list[Path] = field(default_factory=list)
    _logs_skip: Path | None = None
    _logs_before: dict[str, str] = field(default_factory=dict)
    _archive_before: dict[Path, str] = field(default_factory=dict)
    _deleted_by_app: dict[Path, str] = field(default_factory=dict)
    _unwatch: list = field(default_factory=list)

    def _temp_dir(self, env: str) -> Path | None:
        raw = os.environ.get(env)
        if not raw:
            return None
        path = Path(raw)
        return path if _is_within(path, self.basetemp) else None

    @property
    def active(self) -> bool:
        return self.fchat_root is not None or bool(self.archive_roots)

    def record(self) -> None:
        """Take the baseline. Called once the test's fixtures are set up."""
        self.recorded = True
        data = self._temp_dir("FLIST_WORKBENCH_DATA_DIR")
        self.fchat_root = self._temp_dir("FCHAT_DATA_DIR")
        self.archive_roots = [data / d for d in ARCHIVE_DIRS] if data else []
        if self.fchat_root is not None:
            # The data directory may sit inside the F-Chat one in a test;
            # its files are not Logs.
            nested = data if data and _is_within(data, self.fchat_root) else None
            self._logs_skip = nested
            self._logs_before = _log_files(self.fchat_root, skip=nested)
        self._archive_before = {}
        for root in self.archive_roots:
            self._archive_before.update(_walk(root))
        if self.archive_roots:
            self._watch_deletions()
        global _recording
        _recording = self

    def _watch_deletions(self) -> None:
        guard = self
        original_unlink, original_remove, original_rmtree = os.unlink, os.remove, shutil.rmtree

        def unlink(path, *args, **kwargs):
            if "dir_fd" not in kwargs:
                guard._note_deletion(path, sys._getframe(1))
            return original_unlink(path, *args, **kwargs)

        def remove(path, *args, **kwargs):
            if "dir_fd" not in kwargs:
                guard._note_deletion(path, sys._getframe(1))
            return original_remove(path, *args, **kwargs)

        def rmtree(path, *args, **kwargs):
            guard._note_deletion(path, sys._getframe(1))
            return original_rmtree(path, *args, **kwargs)

        os.unlink, os.remove, shutil.rmtree = unlink, remove, rmtree

        def unwatch() -> None:
            os.unlink, os.remove, shutil.rmtree = (
                original_unlink, original_remove, original_rmtree
            )

        self._unwatch.append(unwatch)

    def _note_deletion(self, target, frame) -> None:
        """Keep the bytes of an archive file the app is about to delete."""
        try:
            path = Path(os.fsdecode(target))
            if not any(_is_within(path, root) for root in self.archive_roots):
                return
            if not _by_the_app(frame):
                return
            if path.is_dir():
                self._deleted_by_app.update(_walk(path))
            elif path.is_file() and not path.name.endswith(_SCRATCH_SUFFIXES):
                digest = _sha256(path)
                if digest is not None:
                    self._deleted_by_app[path] = digest
        except Exception:  # noqa: BLE001 - never get in the app's way
            return

    def fchat_wrote(self, path: Path) -> None:
        """F-Chat (played by the test) wrote the Log at `path`: its new
        bytes become the ones that must not change."""
        if self.fchat_root is None or not _is_within(path, self.fchat_root):
            return
        rel = path.resolve().relative_to(self.fchat_root.resolve()).as_posix()
        digest = _sha256(path)
        if digest is not None:
            self._logs_before[rel] = digest

    def _rel(self, path: Path | str) -> str:
        if isinstance(path, str):  # a Log, keyed below the F-Chat root
            path = self.fchat_root / path
        try:
            return path.relative_to(self.basetemp).as_posix()
        except ValueError:
            return path.as_posix()

    def log_changes(self) -> list[str]:
        if self.fchat_root is None:
            return []
        after = _log_files(self.fchat_root, skip=self._logs_skip)
        lines: list[str] = []
        for path in sorted(self._logs_before.keys() - after.keys()):
            lines.append(f"removed  {self._rel(path)}")
        for path in sorted(after.keys() - self._logs_before.keys()):
            lines.append(f"added    {self._rel(path)}")
        for path in sorted(self._logs_before.keys() & after.keys()):
            if self._logs_before[path] != after[path]:
                lines.append(f"modified {self._rel(path)}")
        return lines

    def vanished(self) -> list[str]:
        gone = {p: d for p, d in self._archive_before.items() if not p.exists()}
        gone.update(self._deleted_by_app)
        if not gone:
            return []
        kept = _kept(self.archive_roots)
        return sorted(
            self._rel(p) for p, d in gone.items() if not kept.holds(p, d, self.archive_roots)
        )

    def finish(self) -> None:
        global _recording
        if _recording is self:
            _recording = None
        while self._unwatch:
            self._unwatch.pop()()
        if not self.recorded:
            return  # skipped, or a fixture failed; nothing ran
        found = {
            LOG_UNCHANGED: self.log_changes() if self.active else [],
            NOTHING_VANISHES: self.vanished() if self.active else [],
        }
        problems: list[str] = []
        for rule, lines in found.items():
            if rule in self.exempt:
                continue
            if rule in self.known:
                if not lines and self.call_passed:
                    problems.append(
                        f"{rule}: marked as a known violation fixed by spec "
                        f"#{self.known[rule]}, but the test no longer breaks it; "
                        "remove the marker."
                    )
                continue
            if lines:
                problems.append(_describe(rule, lines))
        if problems:
            pytest.fail("\n\n".join(problems), pytrace=False)


def _describe(rule: str, lines: list[str]) -> str:
    if rule == LOG_UNCHANGED:
        head = "log_unchanged: the test changed a Log, which only F-Chat may do:"
    else:
        head = (
            "nothing_vanishes: these files left the archive and are neither "
            "in the Trash nor inside a Backup:"
        )
    return head + "".join(f"\n  {line}" for line in lines)


def _read_markers(node: pytest.Item) -> tuple[set[str], dict[str, int]]:
    exempt: set[str] = set()
    known: dict[str, int] = {}
    for name in ("invariant_exempt", "known_violation"):
        for mark in node.iter_markers(name):
            if len(mark.args) != 1 or mark.args[0] not in RULES:
                raise pytest.UsageError(
                    f"@{name} takes one rule, {' or '.join(RULES)}; got {mark.args!r}"
                )
            rule = mark.args[0]
            if not str(mark.kwargs.get("reason") or "").strip():
                raise pytest.UsageError(f"@{name}({rule!r}) needs a reason=")
            if name == "invariant_exempt":
                exempt.add(rule)
                continue
            spec = mark.kwargs.get("spec")
            if not isinstance(spec, int) or spec <= 0:
                raise pytest.UsageError(
                    f"@known_violation({rule!r}) needs spec=<issue number> of the "
                    "spec that fixes it"
                )
            known[rule] = spec
    return exempt, known


_GUARD = pytest.StashKey[DataInvariants]()

#: The guard of the test whose body is running, if any.
_recording: DataInvariants | None = None


def fchat_wrote(path: Path) -> None:
    """Tell the running test's guard that F-Chat wrote the Log at `path`.
    The shared Log writer calls this, so a Log a test arranges in its
    body, or an F-Chat append it simulates, is not the app's doing."""
    if _recording is not None:
        _recording.fchat_wrote(path)


@pytest.fixture(autouse=True)
def data_invariants(request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory):
    exempt, known = _read_markers(request.node)
    guard = DataInvariants(tmp_path_factory.getbasetemp(), exempt=exempt, known=known)
    request.node.stash[_GUARD] = guard
    yield guard
    guard.finish()


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item: pytest.Item):
    # The baseline waits for the call: only then have the test's own
    # fixtures pointed the app at its temp directories and filled them.
    guard = item.stash.get(_GUARD, None)
    if guard is not None:
        guard.record()
    outcome = yield
    if guard is not None:
        guard.call_passed = outcome.excinfo is None


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "invariant_exempt(rule, reason): do not check this data invariant "
        "(log_unchanged or nothing_vanishes) for this test",
    )
    config.addinivalue_line(
        "markers",
        "known_violation(rule, spec, reason): this test breaks a data invariant "
        "today and spec #<spec> fixes it; fails once it no longer does",
    )
