"""The MCP log-reading tools (design §3.9–3.10).

Uses real F-Chat binary logs on disk rather than mocks — the label
resolver, the alias fold-in and the hash the classification tools key
on all read straight from the parser, so a stubbed message dict would
test nothing that matters.
"""

from __future__ import annotations

import struct
from pathlib import Path

import pytest

from mcp_helpers import call_tool, mcp_client, tool_error_text

LONG = "A" * 260  # above the 200-char rule threshold, so: Unlabeled
SHORT = "ok"  # below it, so: OOC by rule


def write_log(path: Path, records: list[tuple[int, str, str]]) -> None:
    """Minimal F-Chat 3.0 log writer — see parser.py for the layout."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        for ts, speaker, body in records:
            sb = speaker.encode("utf-8")
            bb = body.encode("utf-8")
            record = (
                struct.pack("<IBB", ts, 0, len(sb))
                + sb
                + struct.pack("<H", len(bb))
                + bb
            )
            f.write(record + struct.pack("<H", len(record)))


@pytest.fixture
def corpus(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Two of the user's characters, three conversations, one channel."""
    root = tmp_path / "fchat"
    monkeypatch.setenv("FCHAT_DATA_DIR", str(root))
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")

    write_log(
        root / "Lady Amber Blaise" / "logs" / "Daelan Envale",
        [
            (1700000000, "Lady Amber Blaise", LONG),
            (1700000060, "Daelan Envale", SHORT),
            (1700000120, "Daelan Envale", "The tavern smells of woodsmoke. " + LONG),
        ],
    )
    write_log(
        root / "Lady Amber Blaise" / "logs" / "#german ooc",
        [(1700000200, "Someone", LONG)],
    )
    write_log(
        root / "Vanessa Arlington" / "logs" / "Daelan Envale",
        [(1700000300, "Vanessa Arlington", LONG)],
    )

    import importlib

    import logs
    import paths
    import server

    importlib.reload(paths)
    importlib.reload(logs)
    importlib.reload(server)
    return root


# ---- listing -----------------------------------------------------------


async def test_list_log_characters(corpus) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(session, "list_log_characters")
    assert {c["name"] for c in body["characters"]} == {
        "Lady Amber Blaise",
        "Vanessa Arlington",
    }


async def test_list_partners_hides_channels_by_default(corpus) -> None:
    async with mcp_client("logs") as session:
        _, without = await call_tool(
            session, "list_partners", character="Lady Amber Blaise"
        )
        _, with_channels = await call_tool(
            session,
            "list_partners",
            character="Lady Amber Blaise",
            include_channels=True,
        )
    assert [p["partner"] for p in without["partners"]] == ["Daelan Envale"]
    assert "#german ooc" in {p["partner"] for p in with_channels["partners"]}


# ---- reading -----------------------------------------------------------


async def test_read_log_messages_resolves_labels_and_hashes(corpus) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session,
            "read_log_messages",
            character="Lady Amber Blaise",
            partner="Daelan Envale",
        )
    assert body["total_matching"] == 3
    labels = [m["label"] for m in body["messages"]]
    # Rule: short messages are OOC without anyone judging them.
    assert labels == ["Unlabeled", "OOC", "Unlabeled"]
    assert all(len(m["hash"]) == 16 for m in body["messages"])


async def test_read_log_messages_filters_by_label(corpus) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session,
            "read_log_messages",
            character="Lady Amber Blaise",
            partner="Daelan Envale",
            labels=["Unlabeled"],
        )
    assert body["total_matching"] == 2
    assert {m["label"] for m in body["messages"]} == {"Unlabeled"}


async def test_read_log_messages_pages(corpus) -> None:
    async with mcp_client("logs") as session:
        _, first = await call_tool(
            session,
            "read_log_messages",
            character="Lady Amber Blaise",
            partner="Daelan Envale",
            limit=2,
        )
        _, second = await call_tool(
            session,
            "read_log_messages",
            character="Lady Amber Blaise",
            partner="Daelan Envale",
            offset=2,
            limit=2,
        )
    assert first["returned"] == 2
    assert first["has_more"] is True
    assert second["returned"] == 1
    assert second["has_more"] is False


async def test_a_missing_log_directory_says_where_to_set_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "nowhere"))
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    import importlib

    import logs
    import server

    importlib.reload(logs)
    importlib.reload(server)

    async with mcp_client("logs") as session:
        result, _ = await call_tool(session, "list_log_characters")
    text = tool_error_text(result)
    assert "log_dir_unavailable" in text
    assert "Settings" in text


# ---- search ------------------------------------------------------------


async def test_search_logs_finds_a_phrase(corpus) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session,
            "search_logs",
            character="Lady Amber Blaise",
            partner="Daelan Envale",
            query="woodsmoke",
        )
    assert body["total_hits"] == 1
    assert "woodsmoke" in body["hits"][0]["text"]


async def test_search_logs_rejects_an_empty_query(corpus) -> None:
    async with mcp_client("logs") as session:
        result, _ = await call_tool(
            session,
            "search_logs",
            character="Lady Amber Blaise",
            partner="Daelan Envale",
            query="   ",
        )
    assert "validation_failed" in tool_error_text(result)


async def test_search_all_partners_reports_per_partner_hits(corpus) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session,
            "search_all_partners",
            character="Lady Amber Blaise",
            query="woodsmoke",
        )
    hits = {p["partner"]: p["hit_count"] for p in body["partners"]}
    assert hits.get("Daelan Envale") == 1


# ---- find_contacts -----------------------------------------------------


async def test_find_contacts_answers_across_every_character(corpus) -> None:
    """The question this exists for: have I ever talked to this person,
    on any of my characters?"""
    async with mcp_client("logs") as session:
        _, body = await call_tool(session, "find_contacts", name="Daelan Envale")
    assert body["matched"] == "exact"
    assert {c["character"] for c in body["conversations"]} == {
        "Lady Amber Blaise",
        "Vanessa Arlington",
    }


async def test_find_contacts_is_case_insensitive(corpus) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(session, "find_contacts", name="daelan envale")
    assert len(body["conversations"]) == 2


async def test_find_contacts_partial_matches_a_fragment(corpus) -> None:
    async with mcp_client("logs") as session:
        _, exact = await call_tool(session, "find_contacts", name="Envale")
        _, partial = await call_tool(
            session, "find_contacts", name="Envale", partial=True
        )
    assert exact["conversations"] == []
    assert len(partial["conversations"]) == 2
    assert partial["matched"] == "partial"


async def test_find_contacts_partial_skips_channels(corpus) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(session, "find_contacts", name="german", partial=True)
    assert body["conversations"] == []


# ---- label coverage ----------------------------------------------------


async def test_label_stats_counts_rule_and_unlabeled(corpus) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session,
            "get_label_stats",
            character="Lady Amber Blaise",
            partner="Daelan Envale",
        )
    assert body["total"] == 3
    assert body["ooc"] == 1  # the short one, by rule
    assert body["unlabeled"] == 2
    assert "get_messages_to_classify" in body["note"]


async def test_label_stats_without_a_partner_walks_the_character(corpus) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session, "get_label_stats", character="Lady Amber Blaise"
        )
    assert body["totals"]["total"] == 3
    assert [p["partner"] for p in body["partners"]] == ["Daelan Envale"]


# ---- semantic search ---------------------------------------------------


async def test_semantic_search_without_an_index_points_at_ingest(
    corpus,
) -> None:
    async with mcp_client("logs") as session:
        result, _ = await call_tool(
            session, "search_logs_semantic", question="what happened at the tavern"
        )
    text = tool_error_text(result)
    assert "no_index" in text
    assert "ingest_logs" in text


async def test_semantic_search_rejects_a_partner_without_a_character(
    corpus,
) -> None:
    async with mcp_client("logs") as session:
        result, _ = await call_tool(
            session,
            "search_logs_semantic",
            question="anything",
            partner="Daelan Envale",
        )
    assert "validation_failed" in tool_error_text(result)


async def test_rag_status_on_a_fresh_install(corpus) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(session, "get_rag_status")
    assert body["chunk_count"] == 0
    assert "ingest_logs" in body["note"]


async def test_alias_group_folds_in_whatever_case_the_caller_uses(
    corpus, tmp_path
) -> None:
    """Linking two log files must fold them together for every spelling
    of both names.

    Alias rows are matched exactly by SQL, so an address the caller
    capitalised differently used to miss the group and report one file's
    numbers as if they were the whole conversation.
    """
    write_log(
        tmp_path / "fchat" / "Lady Amber Blaise" / "logs" / "Asmira",
        [(1700000400, "Asmira", LONG), (1700000460, "Asmira", SHORT)],
    )
    async with mcp_client("logs") as session:
        await call_tool(
            session,
            "add_alias",
            character="Lady Amber Blaise",
            name="Daelan Envale",
            primary_name="Asmira",
        )
        seen = []
        for character, partner in (
            ("Lady Amber Blaise", "Asmira"),
            ("Lady Amber Blaise", "Daelan Envale"),
            ("lady amber blaise", "daelan envale"),
            ("LADY AMBER BLAISE", "asmira"),
        ):
            _, body = await call_tool(
                session,
                "get_label_stats",
                character=character,
                partner=partner,
            )
            seen.append(body["total"])
    # Three records in one file, two in the other — every spelling sees
    # the whole group, never one half of it.
    assert seen == [5, 5, 5, 5]
