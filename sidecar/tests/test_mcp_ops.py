"""The operations tools (design §3.8, §3.10, §3.11).

Phase-5 acceptance: pull, backup, ingest, bundle export/import,
settings and aliases all run through MCP, and the REST routes they were
extracted from still behave the same.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from mcp_helpers import call_tool, mcp_client, tool_error_text
from test_mcp_reads import MAPPING


@pytest.fixture
def workbench(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import character_archive
    import paths

    importlib.reload(paths)
    importlib.reload(character_archive)

    cache = character_archive.cache_root() / "mapping-list.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(MAPPING), encoding="utf-8")

    character_archive.register_character("42", "Lady Amber Blaise")
    character_archive.write_live(
        "42",
        {
            "character": {
                "id": 42,
                "name": "Lady Amber Blaise",
                "description": "[b]Published.[/b]",
            },
            "infotags": {"2": "Human"},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1700000000,
        },
    )

    import server
    import settings as settings_store
    from services import mapping as mapping_service

    importlib.reload(settings_store)
    mapping_service.invalidate()
    importlib.reload(server)
    yield character_archive
    mapping_service.invalidate()


# ---- pull --------------------------------------------------------------


async def test_pull_without_a_session_says_where_to_sign_in(
    workbench, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Credentials never travel through MCP, so the only useful answer
    is to point at the window."""
    async with mcp_client("character") as session:
        result, _ = await call_tool(
            session, "pull_character", character="Lady Amber Blaise"
        )
    text = tool_error_text(result)
    assert "not_signed_in" in text
    assert "Workbench window" in text


async def test_pull_reports_progress_and_returns_a_summary(
    workbench, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import pull as pull_service

    async def fake_run(name: str):
        yield "queued", {"name": name}
        yield "ticket", {}
        yield "fetching", {"name": name}
        yield "images", {"total": 2, "downloaded": 0, "failed": 0}
        yield "image", {"index": 1, "total": 2, "image_id": "a"}
        yield "image", {"index": 2, "total": 2, "image_id": "b"}
        yield "done", {"character_id": "42", "image_count": 2}

    monkeypatch.setattr(pull_service, "run", fake_run)
    async with mcp_client("character") as session:
        _, body = await call_tool(
            session, "pull_character", character="Lady Amber Blaise"
        )
    assert body["character_id"] == "42"
    assert body["images"] == 2
    # A pull refreshes what is published; it must not imply an upload.
    assert "never writes to f-list.net" in body["note"]


async def test_a_pull_failure_surfaces_its_stage(
    workbench, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import pull as pull_service

    async def fake_run(name: str):
        yield "queued", {"name": name}
        yield "error", {"stage": "fetching", "message": "HTTP 503"}

    monkeypatch.setattr(pull_service, "run", fake_run)
    async with mcp_client("character") as session:
        result, _ = await call_tool(
            session, "pull_character", character="Lady Amber Blaise"
        )
    text = tool_error_text(result)
    assert "pull_failed" in text
    assert "HTTP 503" in text


# ---- backups -----------------------------------------------------------


async def test_create_backup_writes_a_zip(workbench) -> None:
    async with mcp_client("character") as session:
        _, body = await call_tool(
            session, "create_backup", character="Lady Amber Blaise"
        )
        assert body["filename"].endswith(".zip")
        _, listed = await call_tool(
            session, "list_backups", character="Lady Amber Blaise"
        )
    assert [b["filename"] for b in listed["backups"]] == [body["filename"]]


async def test_a_backup_note_becomes_the_backups_name(workbench) -> None:
    async with mcp_client("character") as session:
        await call_tool(
            session,
            "create_backup",
            character="Lady Amber Blaise",
            note="before the rewrite",
        )
        _, listed = await call_tool(
            session, "list_backups", character="Lady Amber Blaise"
        )
    assert listed["backups"][0]["name"] == "before the rewrite"


async def test_a_backup_loads_back_into_the_workbench(workbench) -> None:
    """The round trip the backup exists for. It replaces the bench in
    place — the old path made a *new* draft from the backup, which is one
    of the ways a user ended up with several and lost track of which one
    they were editing."""
    async with mcp_client("character") as session:
        await call_tool(
            session, "create_working_set", character="Lady Amber Blaise"
        )
        _, backup = await call_tool(
            session, "create_backup", character="Lady Amber Blaise"
        )
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="[b]Work in progress.[/b]",
        )

        result, _ = await call_tool(
            session,
            "load_backup_into_workbench",
            character="Lady Amber Blaise",
            backup=backup["filename"],
        )
        assert "confirm_required" in tool_error_text(result)

        _, loaded = await call_tool(
            session,
            "load_backup_into_workbench",
            character="Lady Amber Blaise",
            backup=backup["filename"],
            confirm=True,
        )
        assert loaded["loaded"] == backup["filename"]

        _, desc = await call_tool(
            session, "get_description", character="Lady Amber Blaise"
        )
        _, sets = await call_tool(
            session, "list_working_sets", character="Lady Amber Blaise"
        )
    assert desc["description"] == "[b]Published.[/b]"
    assert len(sets["sets"]) == 1, "loading must not add a second draft"


async def test_backing_up_a_character_never_pulled(workbench) -> None:
    workbench.register_character("99", "Ghost Character")
    async with mcp_client("character") as session:
        result, _ = await call_tool(
            session, "create_backup", character="Ghost Character"
        )
    text = tool_error_text(result)
    assert "live_not_found" in text
    assert "Pull the character first" in text


# ---- ingest ------------------------------------------------------------


async def test_ingest_rejects_a_partner_without_a_character(
    workbench,
) -> None:
    async with mcp_client("logs") as session:
        result, _ = await call_tool(
            session, "ingest_logs", partner="Daelan Envale"
        )
    assert "validation_failed" in tool_error_text(result)


async def test_ingest_can_run_in_the_background(
    workbench, monkeypatch: pytest.MonkeyPatch
) -> None:
    import rag_jobs

    started: dict[str, Any] = {}

    class _FakeJob:
        id = "abc123"
        state = "pending"

    def fake_start(scope, *, include_ooc=False, force_rewipe=False):
        started.update(
            scope=scope, include_ooc=include_ooc, force_rewipe=force_rewipe
        )
        return _FakeJob()

    monkeypatch.setattr(rag_jobs, "start", fake_start)
    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session,
            "ingest_logs",
            character="Lady Amber Blaise",
            wait=False,
        )
    assert body["job_id"] == "abc123"
    assert started["scope"] == {"character": "Lady Amber Blaise"}
    assert "get_job" in body["note"]


async def test_ingest_reports_skipped_unlabeled_and_what_to_do(
    workbench, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Silently indexing half a log and reporting success is the
    failure mode this guards against."""
    import rag_jobs

    snapshot = {
        "id": "job1",
        "state": "done",
        "upserted": 4,
        "skipped_existing": 0,
        "skipped_unlabeled": 120,
        "failed": 0,
        "error": None,
    }

    class _Job:
        id = "job1"
        state = "done"

        def to_dict(self):
            return snapshot

    class _Registry:
        def get(self, job_id):
            return _Job()

    monkeypatch.setattr(rag_jobs, "start", lambda *a, **k: _Job())
    monkeypatch.setattr(rag_jobs, "registry", lambda: _Registry())

    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session, "ingest_logs", character="Lady Amber Blaise"
        )
    assert body["skipped_unlabeled"] == 120
    assert "get_messages_to_classify" in body["note"]


async def test_get_job_on_an_unknown_id(workbench) -> None:
    async with mcp_client("logs") as session:
        result, _ = await call_tool(session, "get_job", job_id="nope")
    assert "job_not_found" in tool_error_text(result)


async def test_wiping_the_index_needs_confirmation(workbench) -> None:
    async with mcp_client("logs") as session:
        result, _ = await call_tool(session, "wipe_search_index")
        assert "confirm_required" in tool_error_text(result)
        _, body = await call_tool(session, "wipe_search_index", confirm=True)
    assert body["wiped"] is True


async def test_embedding_probe_reports_an_unreachable_endpoint(
    workbench, monkeypatch: pytest.MonkeyPatch
) -> None:
    import rag_embed

    def boom(settings, timeout=60.0):
        raise rag_embed.EmbedError("connection refused")

    monkeypatch.setattr(rag_embed, "probe", boom)
    async with mcp_client("logs") as session:
        _, body = await call_tool(session, "test_embedding_connection")
    assert body["ok"] is False
    assert "connection refused" in body["error"]


# ---- bundles -----------------------------------------------------------


async def test_a_bundle_round_trips_between_sets(
    workbench, tmp_path: Path
) -> None:
    out = tmp_path / "bundles" / "amber.zip"
    async with mcp_client("character") as session:
        await call_tool(
            session, "create_working_set", character="Lady Amber Blaise", name="Main"
        )
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="bundled text",
        )
        _, exported = await call_tool(
            session,
            "export_working_set_bundle",
            character="Lady Amber Blaise",
            path=str(out),
        )
        assert Path(exported["path"]).is_file()

        _, imported = await call_tool(
            session,
            "import_working_set_bundle",
            character="Lady Amber Blaise",
            path=str(out),
            name="Reimported",
        )
        assert imported["set"] == "Reimported"
        _, desc = await call_tool(
            session,
            "get_description",
            character="Lady Amber Blaise",
            working_set="Reimported",
        )
    assert desc["description"] == "bundled text"


async def test_exporting_to_a_directory_generates_a_filename(
    workbench, tmp_path: Path
) -> None:
    """"Put it in Downloads" is a reasonable thing for a user to say."""
    folder = tmp_path / "downloads"
    folder.mkdir()
    async with mcp_client("character") as session:
        await call_tool(
            session, "create_working_set", character="Lady Amber Blaise", name="Main"
        )
        _, body = await call_tool(
            session,
            "export_working_set_bundle",
            character="Lady Amber Blaise",
            path=str(folder),
        )
    written = Path(body["path"])
    assert written.parent == folder
    assert written.suffix == ".zip"


async def test_importing_a_missing_file(workbench, tmp_path: Path) -> None:
    async with mcp_client("character") as session:
        result, _ = await call_tool(
            session,
            "import_working_set_bundle",
            character="Lady Amber Blaise",
            path=str(tmp_path / "nope.zip"),
        )
    assert "file_not_found" in tool_error_text(result)


async def test_export_restore_zip_names_the_manual_step(
    workbench, tmp_path: Path
) -> None:
    """The hand-off point: a model must not claim this published
    anything."""
    async with mcp_client("character") as session:
        await call_tool(
            session, "create_working_set", character="Lady Amber Blaise", name="Main"
        )
        _, body = await call_tool(
            session,
            "export_restore_zip",
            character="Lady Amber Blaise",
            path=str(tmp_path / "restore.zip"),
        )
    assert Path(body["path"]).is_file()
    assert "uploads this in their browser" in body["next_step"]
    assert "cannot do it for them" in body["next_step"]


async def test_extension_pairing_is_read_only(workbench) -> None:
    async with mcp_client("character") as session:
        _, body = await call_tool(session, "get_extension_pairing_status")
        tools = {t.name: t for t in (await session.list_tools()).tools}
    assert body["paired"] is False
    assert "human action" in body["note"]
    assert tools["get_extension_pairing_status"].annotations.readOnlyHint


# ---- settings ----------------------------------------------------------


async def test_settings_expose_no_inference_server(workbench) -> None:
    """There is nothing to point at any more, so there is nothing to
    leak: no endpoint URL, no API key, no keep-alive. The API key used to
    be reported as a boolean so it could never appear in a transcript;
    now the field is simply gone."""
    async with mcp_client("character") as session:
        _, body = await call_tool(session, "get_settings")
    embedding = body["embedding"]
    assert set(embedding) == {"model", "runs"}
    rendered = json.dumps(body)
    for leak in ("endpoint", "api_key", "keep_alive", "11434", "1234"):
        assert leak not in rendered, leak


async def test_update_settings_clamps_and_reports(workbench) -> None:
    async with mcp_client("character") as session:
        _, body = await call_tool(session, "update_settings", top_k=9999)
        assert body["changed"]["top_k"] == 50
        _, read = await call_tool(session, "get_settings")
    assert read["retrieval"]["top_k"] == 50


async def test_changing_the_embedding_model_warns_about_the_index(
    workbench,
) -> None:
    """An index built with one model's vectors can't be searched with
    another's — silently leaving it in place looks like data loss."""
    async with mcp_client("character") as session:
        _, body = await call_tool(
            session, "update_settings", embed_model="some-other-model"
        )
    assert "wipe_search_index" in body["warning"]


async def test_update_settings_with_nothing_to_change(workbench) -> None:
    async with mcp_client("character") as session:
        result, _ = await call_tool(session, "update_settings")
    assert "nothing to change" in tool_error_text(result)


# ---- aliases -----------------------------------------------------------


async def test_aliases_link_and_unlink(workbench) -> None:
    async with mcp_client("logs") as session:
        _, added = await call_tool(
            session,
            "add_alias",
            character="Lady Amber Blaise",
            name="Daelan Envale",
            primary_name="Asmira",
        )
        assert set(added["group"]) == {"Daelan Envale", "Asmira"}

        _, listed = await call_tool(
            session, "list_aliases", character="Lady Amber Blaise"
        )
        assert listed["groups"][0]["primary"] == "Asmira"

        _, removed = await call_tool(
            session,
            "remove_alias",
            character="Lady Amber Blaise",
            name="Daelan Envale",
        )
    assert removed["removed"] is True


# ---- REST parity -------------------------------------------------------


def test_the_pull_route_still_streams_sse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The extraction into services/pull.py must not change what the
    renderer sees."""
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    from fastapi.testclient import TestClient

    import server
    from services import pull as pull_service

    importlib.reload(server)

    async def fake_run(name: str):
        yield "queued", {"name": name}
        yield "done", {"character_id": "42", "image_count": 0}

    monkeypatch.setattr(pull_service, "run", fake_run)
    client = TestClient(server.app, base_url="http://127.0.0.1:27384")
    with client.stream("POST", "/flist/character/Someone/pull") as resp:
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    assert "event: queued" in body
    assert "event: done" in body
    assert '"character_id": "42"' in body or '"character_id":"42"' in body


def test_the_backup_all_route_still_streams_sse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    from fastapi.testclient import TestClient

    import server
    from services import backup_all as backup_all_service

    importlib.reload(server)

    async def fake_run(kind: str = "manual_bulk", source: str = "manual"):
        yield "start", {"total": 1}
        yield "character", {"name": "A", "status": "saved", "filename": "a.zip"}
        yield "done", {"total": 1, "saved": 1, "unchanged": 0, "failed": 0}

    monkeypatch.setattr(backup_all_service, "run", fake_run)
    client = TestClient(server.app, base_url="http://127.0.0.1:27384")
    with client.stream("POST", "/flist/backup-all") as resp:
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    assert "event: start" in body
    assert "event: character" in body
    assert "event: done" in body
