"""docs/MCP.md lists the tools a client really gets (spec #6, #90).

A user configuring an MCP client picks an endpoint from MCP.md's tool
tables, so each table must hold exactly the tools that endpoint lists,
and its heading the right count. The tables are read against the
endpoints as a client sees them, through the client session, once with
the Log-text switch off (the default) and once with it on: a tool
marked as Log text in MCP.md is listed only after the user turns it on.

Every endpoint also has to speak the glossary: no tool name, title or
description may use a retired or avoided term, since those are the
first words a model reads about the app.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import pytest

import server  # noqa: F401  (building the servers fills the registry)
from mcp_helpers import allow_log_text, mcp_client
from test_conventions import RETIRED_TERMS
from workbench_mcp import ENDPOINTS, endpoint_path

MCP_DOC = Path(__file__).resolve().parents[2] / "docs" / "MCP.md"

#: What marks a row as a Log-text tool, at the start of its purpose.
LOG_TEXT_MARK = "*Log text, opt-in.*"

_HEADING = re.compile(
    r"^### `(?P<path>/mcp[a-z/]*)`: (?P<on>\d+) tools"
    r"(?: \((?P<off>\d+) while Log text is off\))?$"
)
_ROW = re.compile(r"^\| `(?P<name>[a-z_]+)` \| (?P<purpose>.*\S) \|$")


@dataclass
class Table:
    count: int
    count_off: int
    tools: dict[str, str] = field(default_factory=dict)

    @property
    def log_text(self) -> set[str]:
        return {n for n, p in self.tools.items() if p.startswith(LOG_TEXT_MARK)}


def documented() -> dict[str, Table]:
    """Endpoint path -> its table in MCP.md's "Tools by endpoint"."""
    text = MCP_DOC.read_text(encoding="utf-8")
    section = text.split("\n## Tools by endpoint\n", 1)[1].split("\n## ", 1)[0]
    tables: dict[str, Table] = {}
    current: Table | None = None
    for line in section.splitlines():
        if line.startswith("### "):
            m = _HEADING.match(line)
            assert m, f"unreadable endpoint heading in MCP.md: {line!r}"
            on = int(m["on"])
            current = tables[m["path"]] = Table(on, int(m["off"] or on))
        elif line.startswith("| `"):
            m = _ROW.match(line)
            assert m and current is not None, f"unreadable tool row in MCP.md: {line!r}"
            assert m["name"] not in current.tools, f"{m['name']} listed twice"
            current.tools[m["name"]] = m["purpose"]
    return tables


async def _listed(suffix: str) -> set[str]:
    async with mcp_client(suffix) as session:
        return {t.name for t in (await session.list_tools()).tools}


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The switch lives in settings.db: never read or change the user's."""
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    return tmp_path


def test_mcp_md_has_one_table_per_endpoint() -> None:
    assert set(documented()) == {endpoint_path(s) for s in ENDPOINTS}


@pytest.mark.parametrize("suffix", list(ENDPOINTS))
async def test_an_endpoint_lists_the_tools_its_table_names(data_dir, suffix: str) -> None:
    table = documented()[endpoint_path(suffix)]

    off = await _listed(suffix)
    allow_log_text()
    on = await _listed(suffix)

    assert on == set(table.tools), "MCP.md's table differs from the endpoint"
    assert on - off == table.log_text, "the Log-text marks differ from what is hidden"
    assert (table.count, table.count_off) == (len(on), len(off)), "a count is wrong"


@pytest.mark.parametrize("suffix", list(ENDPOINTS))
async def test_no_tool_speaks_a_retired_or_avoided_term(data_dir, suffix: str) -> None:
    allow_log_text()
    async with mcp_client(suffix) as session:
        tools = (await session.list_tools()).tools
    found = []
    for t in tools:
        # A name is words joined by underscores; read it as prose.
        for text in (t.name.replace("_", " "), t.title or "", t.description or ""):
            for term, rx in RETIRED_TERMS.items():
                if rx.search(text):
                    found.append(f"{t.name}: {term!r} in {text[:60]!r}")
    assert not found, "\n".join(found)


#: A Restore loads a Backup into the Workbench (GLOSSARY.md), and only
#: a tool doing that may say so in its name.
RESTORE_TOOLS = {"load_backup_into_workbench"}

_RESTORE = re.compile(r"\brestor", re.IGNORECASE)
_SENTENCE = re.compile(r"(?<=[.;:!?])\s+")


@pytest.mark.parametrize("suffix", list(ENDPOINTS))
async def test_taking_something_out_of_the_trash_is_putting_it_back(
    data_dir, suffix: str
) -> None:
    """Taking something out of the Trash is putting it back, never a
    Restore: no tool may call it one, in its name or its words."""
    allow_log_text()
    async with mcp_client(suffix) as session:
        tools = (await session.list_tools()).tools
    found = []
    for t in tools:
        if "restore" in t.name and t.name not in RESTORE_TOOLS:
            found.append(f"{t.name}: names a Restore")
        for text in (t.title or "", t.description or ""):
            for sentence in _SENTENCE.split(text):
                if "trash" in sentence.lower() and _RESTORE.search(sentence):
                    found.append(f"{t.name}: {sentence.strip()[:80]!r}")
    assert not found, "\n".join(found)
