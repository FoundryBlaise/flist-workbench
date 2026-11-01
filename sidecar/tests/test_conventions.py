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
  subclass (one handler answers `{code, message}`), not a bare
  `HTTPException`.
* retired-term: user-facing text (sidecar strings, MCP tool
  descriptions, renderer and main-process text outside comments) does
  not use a term GLOSSARY.md retired or avoids.

Not checked yet: "snapshot" and "bundle" (retired in GLOSSARY.md) still
name live routes, payload fields and MCP tools until docs/CLEANUP_PLAN.md
step 5 removes them, so a text scan cannot tell a leftover word from a
field name. Add them here once those are gone.
"""

from __future__ import annotations

import ast
import re
import subprocess
from collections import Counter, defaultdict
from functools import cache
from pathlib import Path

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

# Bare HTTPException sites per (file, enclosing function) when the rule
# was introduced. May only shrink: new refusals subclass
# refusals.Refusal.
HTTP_EXCEPTION_ALLOWED: dict[tuple[str, str], int] = {
    ("sidecar/server.py", "_foreign_http"): 1,
    ("sidecar/server.py", "_require_restore_auth"): 1,
    ("sidecar/server.py", "_require_valid_set_id"): 1,
    ("sidecar/server.py", "flist_avatar"): 3,
    ("sidecar/server.py", "flist_character_export_zip"): 1,
    ("sidecar/server.py", "flist_character_image"): 1,
    ("sidecar/server.py", "flist_character_image_by_id"): 1,
    ("sidecar/server.py", "flist_character_image_remove"): 1,
    ("sidecar/server.py", "flist_character_image_upload"): 3,
    ("sidecar/server.py", "flist_character_inline"): 1,
    ("sidecar/server.py", "flist_character_live"): 1,
    ("sidecar/server.py", "flist_character_set_export"): 1,
    ("sidecar/server.py", "flist_character_set_import"): 3,
    ("sidecar/server.py", "flist_character_set_payload_get"): 1,
    ("sidecar/server.py", "flist_character_set_payload_put"): 5,
    ("sidecar/server.py", "flist_character_sets_activate"): 1,
    ("sidecar/server.py", "flist_character_sets_create"): 2,
    ("sidecar/server.py", "flist_character_sets_delete"): 1,
    ("sidecar/server.py", "flist_character_sets_duplicate"): 2,
    ("sidecar/server.py", "flist_character_sets_rename"): 2,
    ("sidecar/server.py", "flist_character_snapshot"): 1,
    ("sidecar/server.py", "flist_character_snapshot_read"): 1,
    ("sidecar/server.py", "flist_character_trash_file"): 1,
    ("sidecar/server.py", "flist_character_workbench_load_backup"): 4,
    ("sidecar/server.py", "flist_character_workbench_load_preflight"): 2,
    ("sidecar/server.py", "flist_character_working_put"): 3,
    ("sidecar/server.py", "flist_character_zip_backup"): 1,
    ("sidecar/server.py", "flist_character_zip_backup_create_set"): 3,
    ("sidecar/server.py", "flist_character_zip_backup_delete"): 2,
    ("sidecar/server.py", "flist_character_zip_backup_download"): 1,
    ("sidecar/server.py", "flist_character_zip_backup_payload"): 4,
    ("sidecar/server.py", "flist_character_zip_backup_rename"): 3,
    ("sidecar/server.py", "flist_mapping_list"): 2,
    ("sidecar/server.py", "flist_session_create"): 1,
    ("sidecar/server.py", "foreign_character_avatar"): 3,
    ("sidecar/server.py", "foreign_character_image"): 4,
    ("sidecar/server.py", "labels_fill_unlabeled"): 1,
    ("sidecar/server.py", "labels_override"): 1,
    ("sidecar/server.py", "labels_override_many"): 1,
    ("sidecar/server.py", "labels_rollup"): 1,
    ("sidecar/server.py", "logs_characters"): 1,
    ("sidecar/server.py", "profile"): 4,
    ("sidecar/server.py", "rag_job_cancel"): 1,
    ("sidecar/server.py", "rag_job_get"): 1,
    ("sidecar/server.py", "rag_lexical_rebuild"): 1,
    ("sidecar/server.py", "render_deliver"): 2,
    ("sidecar/server.py", "restore_image_ids"): 2,
    ("sidecar/server.py", "restore_saved"): 1,
    ("sidecar/server.py", "restore_snapshot"): 1,
    ("sidecar/server.py", "settings_update"): 2,
}


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
# retired-term

# GLOSSARY.md: the Electron window is "the app window"; a bare
# "Workbench" is the editable copy.
WORKBENCH_WINDOW = re.compile(r"\bWorkbench\s+window\b", re.IGNORECASE)
# GLOSSARY.md, Retired terms: replaced by Workbench. With the space it
# cannot be an identifier (`working_set`, `workingSet`, `working-sets/`).
WORKING_SET = re.compile(r"\bworking\s+sets?\b", re.IGNORECASE)

RETIRED_TERMS = {"Workbench window": WORKBENCH_WINDOW, "working set": WORKING_SET}

# User-facing "working set" left over until docs/CLEANUP_PLAN.md step 5
# (MCP surface) and the renderer's remaining set UI are reworked, per
# file. May only shrink. "Workbench window" has no allowance.
WORKING_SET_ALLOWED: dict[str, int] = {
    "renderer/src/components/ExternalChangeBanner.tsx": 1,
    "renderer/src/features/flist/FlistCharacterZone.tsx": 1,
    "renderer/src/features/flist/ImagesTab.tsx": 2,
    "renderer/src/features/flist/UserscriptHelpModal.tsx": 2,
    "renderer/src/features/flist/imageUsage.ts": 1,
    "renderer/src/features/flist/working-sets/CrossCharacterImportModal.tsx": 1,
    "renderer/src/features/foreign/ForeignWorkspace.tsx": 1,
    "renderer/src/features/sidebar/UnifiedCharacterPicker.tsx": 1,
    "renderer/src/state.ts": 2,
    "sidecar/character_archive.py": 1,
    "sidecar/services/payload_ops.py": 1,
    "sidecar/workbench_mcp/__init__.py": 2,
    "sidecar/workbench_mcp/_context.py": 4,
    "sidecar/workbench_mcp/resources.py": 1,
    "sidecar/workbench_mcp/tools_edit.py": 7,
    "sidecar/workbench_mcp/tools_foreign.py": 1,
    "sidecar/workbench_mcp/tools_ops.py": 7,
    "sidecar/workbench_mcp/tools_sets.py": 7,
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


def retired_term_sites() -> dict[str, dict[str, list[str]]]:
    """term -> file -> sites."""
    found: dict[str, dict[str, list[str]]] = {t: defaultdict(list) for t in RETIRED_TERMS}

    def scan(path: str, line: int, text: str, base: int = 0) -> None:
        for term, rx in RETIRED_TERMS.items():
            for m in rx.finditer(text):
                at = line + text.count("\n", 0, m.start()) - base
                found[term][path].append(
                    f'{path}:{at}: "{m.group(0)}" in user-facing text (rule retired-term,'
                    " see GLOSSARY.md)"
                )

    for path in sidecar_sources():
        for line, text in python_texts(parse(path)):
            scan(path, line, text)
    for path in ui_sources():
        scan(path, 1, strip_ts_comments((ROOT / path).read_text(encoding="utf-8")))
    return found


def test_no_workbench_window_in_user_facing_text():
    sites = [s for per_file in retired_term_sites()["Workbench window"].values() for s in per_file]
    assert not sites, report("retired-term", sites)


def test_working_set_only_where_it_is_still_allowlisted():
    check_ratchet("retired-term", dict(retired_term_sites()["working set"]), WORKING_SET_ALLOWED)


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
