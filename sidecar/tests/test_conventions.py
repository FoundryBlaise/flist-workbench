"""House rules checked over the tracked source, so review need not.

Each rule is a deterministic scan: no app, no network. A rule that has
old violations carries an allowlist of exactly those. The allowlists
may only shrink: adding to one needs a reason a reviewer accepts, and
when a site is fixed the test fails until its entry is lowered or
removed, so a fix cannot quietly make room for a new violation.

Rules:

* name-regex-fullmatch: name and id checks use `fullmatch`. `.match`
  anchors only the start, and `$` also matches before a trailing
  newline, so `.match` with `^...$` lets "name\\n" through. Prefix
  checks on message text are the legitimate exception.
* typed-refusal: the sidecar refuses with a `refusals.Refusal`
  subclass (one handler answers `{code, message, details}`), not a
  bare `HTTPException`.
* atomic-write: the sidecar writes files only through `atomic_write`
  (unique temp file, fsync, one-step replace), so a crash never
  leaves a broken file. No `write_text`/`write_bytes`, no `open` for
  writing and no fixed `.tmp` name anywhere else.
* router-layering: every REST route lives in a router under
  `sidecar/routers/`; only `server.py` (app setup and router
  registration) imports routers, and nothing imports `server.py`.
* label-layering: SQL on the labels table lives only in the Label
  store (`labels.py`) and the Labels service (`services/labels.py`);
  REST routers and MCP tools take only pure names from the store and
  reach Labels through the service.
* retired-term: user-facing prose (sidecar strings, MCP tool
  descriptions, renderer and main-process strings and JSX text, and
  the overview and install guide) does not use a term GLOSSARY.md
  retired or avoids. Only text with a space in it counts as prose, so
  a route, field or MCP tool still named
  "snapshot" or "bundle" is not a hit until docs/CLEANUP_PLAN.md
  removes it, but "Live snapshot" in a message is.
"""

from __future__ import annotations

import ast
import re
import subprocess
from collections import Counter, defaultdict
from functools import cache
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@cache
def tracked(*prefixes: str) -> tuple[str, ...]:
    out = subprocess.run(
        ["git", "ls-files", "--", *prefixes],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    ).stdout
    return tuple(out.split())


def sidecar_sources() -> list[str]:
    return [p for p in tracked("sidecar") if p.endswith(".py") and not p.startswith("sidecar/tests/")]


def ui_sources() -> list[str]:
    def is_test(p: str) -> bool:
        return ".test." in p or "/__tests__/" in p or p.startswith("renderer/src/test/")

    return [
        p
        for p in tracked("renderer/src", "electron")
        if p.endswith((".ts", ".tsx")) and not is_test(p)
    ]


def user_docs() -> list[str]:
    """Docs a user reads to learn the app: the overview, the install
    guide every release links to, and the guide to connecting a model.
    Design records and plans are history and keep the words of their
    day."""
    return ["docs/OVERVIEW.md", "docs/INSTALL_WINDOWS.md", "docs/MCP.md"]


@cache
def parse(path: str) -> ast.Module:
    return ast.parse((ROOT / path).read_text(encoding="utf-8"), filename=path)


def report(rule: str, sites: list[str]) -> str:
    return f"{len(sites)} violation(s) of {rule}:\n" + "\n".join(f"  {s}" for s in sites)


def check_ratchet(rule: str, found: dict[object, list[str]], allowed: dict[object, int]) -> None:
    """`found` maps a key to its sites ("file:line ..."); `allowed`
    is how many sites each key may have."""
    problems = []
    for key, sites in sorted(found.items(), key=lambda kv: str(kv[0])):
        limit = allowed.get(key, 0)
        if len(sites) > limit:
            problems.append(f"{key}: {len(sites)} site(s), {limit} allowed")
            problems.extend(f"    {s}" for s in sites)
    for key, limit in sorted(allowed.items(), key=lambda kv: str(kv[0])):
        have = len(found.get(key, []))
        if have < limit:
            problems.append(
                f"{key}: allowlisted for {limit}, only {have} left; lower the allowlist entry"
                " (it may only shrink)"
            )
    assert not problems, f"{rule}:\n" + "\n".join(problems)


# ---------------------------------------------------------------------------
# name-regex-fullmatch

# Prefix checks on message text, not names. May only shrink.
MATCH_ALLOWED: set[tuple[str, str]] = {
    ("sidecar/labels.py", "_PARENS_PREFIX"),
    ("sidecar/parser.py", "_OOC_PREFIX"),
}


def match_calls(path: str) -> list[tuple[int, str]]:
    sites = []
    for node in ast.walk(parse(path)):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "match"
        ):
            sites.append((node.lineno, ast.unparse(node.func.value)))
    return sites


def test_name_regexes_use_fullmatch():
    sites = [
        f"{path}:{line}: {receiver}.match( -> use .fullmatch (rule name-regex-fullmatch)"
        for path in sidecar_sources()
        for line, receiver in match_calls(path)
        if (path, receiver) not in MATCH_ALLOWED
    ]
    assert not sites, report("name-regex-fullmatch", sites)


def test_the_fullmatch_allowlist_has_no_stale_entries():
    present = {(path, receiver) for path in sidecar_sources() for _, receiver in match_calls(path)}
    stale = sorted(MATCH_ALLOWED - present)
    assert not stale, f"remove from MATCH_ALLOWED (it may only shrink): {stale}"


# ---------------------------------------------------------------------------
# typed-refusal

# Bare HTTPException sites per (file, enclosing function). Emptied by
# #69 (errors have one shape); may only stay empty.
HTTP_EXCEPTION_ALLOWED: dict[tuple[str, str], int] = {}


def http_exception_sites(path: str) -> dict[tuple[str, str], list[str]]:
    found: dict[tuple[str, str], list[str]] = defaultdict(list)

    def visit(node: ast.AST, func: str) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            func = node.name
        if isinstance(node, ast.Call):
            f = node.func
            name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None
            if name == "HTTPException":
                found[(path, func)].append(
                    f"{path}:{node.lineno}: HTTPException( in {func} -> raise a refusals.Refusal"
                    " subclass (rule typed-refusal)"
                )
        for child in ast.iter_child_nodes(node):
            visit(child, func)

    visit(parse(path), "<module>")
    return found


def test_refusals_are_typed():
    found: dict[object, list[str]] = {}
    for path in sidecar_sources():
        found.update(http_exception_sites(path))
    check_ratchet("typed-refusal", found, HTTP_EXCEPTION_ALLOWED)


# ---------------------------------------------------------------------------
# atomic-write

ATOMIC_WRITE_MODULE = "sidecar/atomic_write.py"

# Writes that are not a file replaced whole, per (file, enclosing
# function). May only shrink.
WRITE_ALLOWED: dict[tuple[str, str], int] = {
    # The activity log is appended a line at a time; a torn last line
    # is skipped when it is read back.
    ("sidecar/flist_activity.py", "_append_to_disk"): 1,
}

_WRITE_METHODS = {"write_text", "write_bytes"}


def _write_mode(node: ast.Call) -> str | None:
    """The mode of an `open(...)` or `<path>.open(...)` call, when it
    writes."""
    f = node.func
    if isinstance(f, ast.Name) and f.id == "open":
        position = 1
    elif isinstance(f, ast.Attribute) and f.attr == "open":
        position = 0
    else:
        return None
    mode = node.args[position] if len(node.args) > position else None
    for kw in node.keywords:
        if kw.arg == "mode":
            mode = kw.value
    if isinstance(mode, ast.Constant) and isinstance(mode.value, str):
        return mode.value if set(mode.value) & set("wax+") else None
    return None


def file_write_sites(path: str) -> dict[tuple[str, str], list[str]]:
    found: dict[tuple[str, str], list[str]] = defaultdict(list)

    def visit(node: ast.AST, func: str) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            func = node.name
        what = None
        if isinstance(node, ast.Call):
            f = node.func
            if (
                isinstance(f, ast.Attribute)
                and f.attr in _WRITE_METHODS
                and ast.unparse(f.value) != "atomic_write"
            ):
                what = f"{f.attr}("
            elif (mode := _write_mode(node)) is not None:
                what = f"open(..., {mode!r})"
        elif (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and node.value.endswith(".tmp")
        ):
            what = f"fixed temp name {node.value!r}"
        if what is not None:
            found[(path, func)].append(
                f"{path}:{node.lineno}: {what} in {func} -> write through atomic_write"
                " (rule atomic-write)"
            )
        for child in ast.iter_child_nodes(node):
            visit(child, func)

    visit(parse(path), "<module>")
    return found


def test_files_are_written_atomically():
    found: dict[object, list[str]] = {}
    for path in sidecar_sources():
        if path != ATOMIC_WRITE_MODULE:
            found.update(file_write_sites(path))
    check_ratchet("atomic-write", found, WRITE_ALLOWED)


# ---------------------------------------------------------------------------
# router-layering

ENTRY_MODULE = "sidecar/server.py"
ROUTE_DECORATORS = {"get", "post", "put", "patch", "delete", "api_route", "websocket", "route"}


def imported_names(path: str) -> list[tuple[int, str]]:
    """(line, dotted name) of everything `path` imports; `from a import b`
    gives both `a` and `a.b`, and a relative import gives `.`."""
    names = []
    for node in ast.walk(parse(path)):
        if isinstance(node, ast.Import):
            names.extend((node.lineno, alias.name) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                names.append((node.lineno, "."))
                continue
            names.append((node.lineno, node.module or ""))
            names.extend((node.lineno, f"{node.module}.{alias.name}") for alias in node.names)
    return names


def test_only_the_entry_module_imports_routers():
    """A router never imports another router, and nothing below the REST
    surface (services, the archive, MCP tools) imports a router or the
    entry module: what two routers share lives in services/."""
    sites = [
        f"{path}:{line}: imports {name} (rule router-layering)"
        for path in sidecar_sources()
        if path != ENTRY_MODULE
        for line, name in imported_names(path)
        if name in ("server", "routers")
        or name.startswith(("server.", "routers."))
        or (name == "." and path.startswith("sidecar/routers/"))
    ]
    assert not sites, report("router-layering", sites)


def test_the_entry_module_declares_no_routes():
    """server.py holds app setup, middleware, error handlers and router
    registration; every route lives in a router under routers/."""
    sites = [
        f"{ENTRY_MODULE}:{node.lineno}: route {node.name} (rule router-layering)"
        for node in ast.walk(parse(ENTRY_MODULE))
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        for deco in node.decorator_list
        if isinstance(deco, ast.Call)
        and isinstance(deco.func, ast.Attribute)
        and deco.func.attr in ROUTE_DECORATORS
    ]
    assert not sites, report("router-layering", sites)


# ---------------------------------------------------------------------------
# label-layering

LABEL_SQL_HOMES = {"sidecar/labels.py", "sidecar/services/labels.py"}
ADAPTER_PREFIXES = ("sidecar/routers/", "sidecar/workbench_mcp/")
#: What a router or MCP tool may take from the Label store: names and
#: pure helpers that touch no database, and the rule settings (#70 owns
#: those). Reading or writing Labels goes through services/labels.py.
LABEL_STORE_PURE = {
    "LABEL_IC",
    "LABEL_OOC",
    "LABEL_UNLABELED",
    "COMPACT_RULES",
    "PROMPT_PRESETS",
    "DEFAULT_THRESHOLD_CHARS",
    "LabelsSettings",
    "msg_hash",
    "resolve",
    "load_settings",
}
_LABEL_SQL = re.compile(r"\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+labels\b", re.IGNORECASE)


def label_sql_sites(path: str, tree: ast.Module | None = None) -> list[str]:
    return [
        f"{path}:{node.lineno}: SQL on the labels table (rule label-layering)"
        for node in ast.walk(tree or parse(path))
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and _LABEL_SQL.search(node.value)
    ]


def label_store_uses(path: str, tree: ast.Module | None = None) -> list[str]:
    """Uses of the Label store (`labels.py`) in `path` beyond its pure
    names, however the module was imported."""
    tree = tree or parse(path)
    bound: set[str] = set()
    sites = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            bound.update(a.asname or a.name for a in node.names if a.name == "labels")
        elif isinstance(node, ast.ImportFrom) and node.module == "labels" and not node.level:
            sites.extend(
                f"{path}:{node.lineno}: imports labels.{a.name} (rule label-layering)"
                for a in node.names
                if a.name not in LABEL_STORE_PURE
            )
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id in bound
            and node.attr not in LABEL_STORE_PURE
        ):
            sites.append(f"{path}:{node.lineno}: labels.{node.attr} (rule label-layering)")
    return sites


def test_label_sql_lives_in_the_label_store_and_service():
    """Only the Label store and the Labels service speak SQL to the
    labels table, so a Label behaviour cannot be implemented twice."""
    sites = [
        site
        for path in sidecar_sources()
        if path not in LABEL_SQL_HOMES
        for site in label_sql_sites(path)
    ]
    assert not sites, report("label-layering", sites)


def test_routes_and_tools_reach_labels_through_the_service():
    """REST routes and MCP tools neither open the Label store nor call
    its readers and writers: they parse, call services/labels.py and
    shape the answer, so REST and MCP give the same result."""
    sites = [
        site
        for path in sidecar_sources()
        if path.startswith(ADAPTER_PREFIXES)
        for site in label_store_uses(path)
    ]
    assert not sites, report("label-layering", sites)


def test_the_label_layering_check_sees_store_calls_and_sql():
    """The rule's scanners find what they are for (guards the guard)."""
    import textwrap

    src = textwrap.dedent(
        """
        import labels as store
        from labels import upsert_label, msg_hash
        store.LABEL_IC
        store.connect()
        conn.execute("DELETE FROM labels WHERE hash = ?")
        """
    )
    path = "sidecar/workbench_mcp/_example.py"
    tree = ast.parse(src)
    uses = label_store_uses(path, tree)
    sql = label_sql_sites(path, tree)
    assert [u.split(": ", 1)[1] for u in uses] == [
        "imports labels.upsert_label (rule label-layering)",
        "labels.connect (rule label-layering)",
    ]
    assert len(sql) == 1


# ---------------------------------------------------------------------------
# retired-term

def _word(pattern: str) -> re.Pattern[str]:
    return re.compile(rf"\b{pattern}\b", re.IGNORECASE)


# Term -> pattern. Each is a GLOSSARY.md retired term or an _Avoid_
# word that cannot mean anything else in this app's prose.
RETIRED_TERMS: dict[str, re.Pattern[str]] = {
    # The Electron window is "the app window"; a bare "Workbench" is the
    # editable copy.
    "Workbench window": _word(r"Workbench\s+window"),
    # Retired terms.
    "working set": _word(r"working\s+sets?"),
    "snapshot": _word(r"snapshots?"),
    "bundle": _word(r"bundles?"),
    # _Avoid_ for Label.
    "verdict": _word(r"verdicts?"),
    "classification": _word(r"classifications?"),
    # _Avoid_ for Log, Trash and Index.
    "transcript": _word(r"transcripts?"),
    "chat history": _word(r"chat\s+histor(?:y|ies)"),
    "recycle bin": _word(r"recycle\s+bins?"),
    "vector DB": _word(r"vector\s+(?:db|database)s?"),
    "RAG store": _word(r"rag\s+stores?"),
}

# Prose left over, per term and file, until docs/CLEANUP_PLAN.md steps 3
# and 5 (one Workbench, the MCP surface) rework it. May only shrink. A
# term not listed here has no allowance.
WORKING_SET_ALLOWED: dict[str, int] = {}

SNAPSHOT_ALLOWED: dict[str, int] = {}

BUNDLE_ALLOWED: dict[str, int] = {}

VERDICT_ALLOWED: dict[str, int] = {
    "renderer/src/features/logs/LogViewer.tsx": 5,
    "renderer/src/features/settings/SettingsModal.tsx": 1,
    "sidecar/labels.py": 3,
}

CLASSIFICATION_ALLOWED: dict[str, int] = {
    "sidecar/labels.py": 2,
    "sidecar/services/retrieval.py": 1,
}

TRANSCRIPT_ALLOWED: dict[str, int] = {}

RETIRED_TERM_ALLOWED: dict[str, dict[str, int]] = {
    "working set": WORKING_SET_ALLOWED,
    "snapshot": SNAPSHOT_ALLOWED,
    "bundle": BUNDLE_ALLOWED,
    "verdict": VERDICT_ALLOWED,
    "classification": CLASSIFICATION_ALLOWED,
    "transcript": TRANSCRIPT_ALLOWED,
}


def python_texts(tree: ast.Module) -> list[tuple[int, str]]:
    """Every string literal, except docstrings nobody outside the code
    reads. Docstrings of MCP tools and resources are their descriptions,
    so those count."""
    private_docs: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        body = node.body
        if not (body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant)):
            continue
        published = False
        for deco in getattr(node, "decorator_list", []):
            f = deco.func if isinstance(deco, ast.Call) else deco
            name = f.id if isinstance(f, ast.Name) else getattr(f, "attr", None)
            published = published or name in ("tool", "resource")
        if not published:
            private_docs.add(id(body[0].value))
    return [
        (node.lineno, node.value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in private_docs
    ]


_REGEX_AFTER = set("(,=:[!&|?{};+-*%~^")


def strip_ts_comments(src: str) -> str:
    """The source with every comment blanked (newlines kept, so line
    numbers hold). Strings, template literals, regex literals and JSX
    text stay. A quote opens a string that ends at its partner or at the
    end of the line, so an apostrophe in JSX text spoils one line at most.
    """
    out = list(src)
    i, n = 0, len(src)
    prev = ""  # last significant character outside comments

    def blank(a: int, b: int) -> None:
        for k in range(a, b):
            if out[k] != "\n":
                out[k] = " "

    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            end = src.find("\n", i)
            end = n if end == -1 else end
            blank(i, end)
            i = end
            continue
        if c == "/" and nxt == "*":
            end = src.find("*/", i + 2)
            end = n if end == -1 else end + 2
            blank(i, end)
            i = end
            continue
        if c in "\"'":
            j = i + 1
            while j < n and src[j] not in (c, "\n"):
                j += 2 if src[j] == "\\" else 1
            i, prev = j + 1, c
            continue
        if c == "`":
            j = i + 1
            while j < n and src[j] != "`":
                j += 2 if src[j] == "\\" else 1
            i, prev = j + 1, c
            continue
        if c == "/" and (prev in _REGEX_AFTER or prev == ""):
            j, in_class = i + 1, False
            while j < n and src[j] != "\n":
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                elif src[j] == "/" and not in_class:
                    break
                j += 1
            i, prev = j + 1, "/"
            continue
        if not c.isspace():
            prev = c
        i += 1
    return "".join(out)


# A string literal, or JSX text: what sits between a tag's `>` and the
# next `<` or `{`. An arrow's `=>` opens no text, and a run holding
# `=`, `;`, `|` or `&` is code after a type's closing `>`, not text. A
# backtick ends the run too: a template literal spans lines, so a run
# that swallowed its opening one would pair every later literal wrongly.
_TS_TEXT = re.compile(
    r"""(?<![=-])>(?P<jsx>[^<>{}=;|&`]*)(?=[<{])"""
    r"""|'(?P<sq>(?:[^'\\\n]|\\.)*)'"""
    r"""|"(?P<dq>(?:[^"\\\n]|\\.)*)\""""
    r"""|`(?P<bt>(?:[^`\\]|\\.)*)`"""
)


def ts_texts(src: str) -> list[tuple[int, str]]:
    """(line, text) of every string literal and JSX text in `src`,
    whose comments are already blanked."""
    texts = []
    for m in _TS_TEXT.finditer(src):
        group = m.lastgroup
        assert group is not None
        start = m.start(group)
        texts.append((src.count("\n", 0, start) + 1, m.group(group)))
    return texts


def is_prose(text: str) -> bool:
    """Words with a space between them; never an identifier, key or path."""
    return any(c.isspace() for c in text.strip())


@cache
def retired_term_sites() -> dict[str, dict[str, list[str]]]:
    """term -> file -> sites."""
    found: dict[str, dict[str, list[str]]] = {t: defaultdict(list) for t in RETIRED_TERMS}

    def scan(path: str, line: int, text: str) -> None:
        if not is_prose(text):
            return
        for term, rx in RETIRED_TERMS.items():
            for m in rx.finditer(text):
                at = line + text.count("\n", 0, m.start())
                found[term][path].append(
                    f'{path}:{at}: "{m.group(0)}" in user-facing text (rule retired-term,'
                    " see GLOSSARY.md)"
                )

    for path in sidecar_sources():
        for line, text in python_texts(parse(path)):
            scan(path, line, text)
    for path in ui_sources():
        src = strip_ts_comments((ROOT / path).read_text(encoding="utf-8"))
        for line, text in ts_texts(src):
            scan(path, line, text)
    for path in user_docs():
        scan(path, 1, (ROOT / path).read_text(encoding="utf-8"))
    return found


@pytest.mark.parametrize("term", sorted(RETIRED_TERMS))
def test_retired_terms_only_where_still_allowlisted(term: str):
    check_ratchet(
        f"retired-term ({term})", dict(retired_term_sites()[term]), RETIRED_TERM_ALLOWED.get(term, {})
    )


# ---------------------------------------------------------------------------
# The scanners themselves


def test_comment_stripping_keeps_text_and_drops_comments():
    src = (
        "const a = 'x // y' // working set\n"
        "/* working set\n   working set */\n"
        "const r = /\\/\\/ working set/\n"
        "<p>Don't touch the working set</p>\n"
        "{/* the working set */}\n"
    )
    stripped = strip_ts_comments(src)
    assert stripped.count("\n") == src.count("\n")
    lines = stripped.split("\n")
    assert "'x // y'" in lines[0] and "working" not in lines[0]
    assert "working" not in lines[1] + lines[2]
    assert "working set" in lines[3]
    assert "working set" in lines[4]
    assert "working" not in lines[5]


def test_only_prose_in_strings_and_jsx_text_counts():
    src = strip_ts_comments(
        "const snapshot = load('snapshot')\n"
        "type Archive = Record<string, unknown> | null\n"
        "  snapshots: Entry[]\n"
        "const url = `/character/${id}/snapshots`\n"
        "const msg = 'Pull a Live snapshot first'\n"
        "<p>Don't open a snapshot here</p>\n"
        "<b>{count}</b>\n"
    )
    prose = [(line, text.strip()) for line, text in ts_texts(src) if is_prose(text)]
    assert prose == [(5, "Pull a Live snapshot first"), (6, "Don't open a snapshot here")]


def test_private_docstrings_are_not_user_facing_but_tool_descriptions_are():
    tree = ast.parse(
        '"""Module doc: Workbench window."""\n'
        "@tool(tags='x')\n"
        "def published():\n"
        '    """Tool description: Workbench window."""\n'
        "def private():\n"
        '    """Private doc: Workbench window."""\n'
        '    return "Message: Workbench window"\n'
    )
    texts = sorted(text for _, text in python_texts(tree) if "Workbench" in text)
    assert texts == ["Message: Workbench window", "Tool description: Workbench window."]
