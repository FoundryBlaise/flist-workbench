"""The MCP endpoints speak the glossary (spec #6, #90).

No tool name, title or description may use a retired or avoided term,
since those are the first words a model reads about the app.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import server  # noqa: F401  (building the servers fills the registry)
from mcp_helpers import allow_log_text, mcp_client
from test_conventions import RETIRED_TERMS
from workbench_mcp import ENDPOINTS


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The switch lives in settings.db: never read or change the user's."""
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    return tmp_path


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
