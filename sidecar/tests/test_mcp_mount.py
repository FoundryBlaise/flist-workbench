"""The MCP endpoints are reachable and defended (design §2.1, §2.3).

These are the phase-0 acceptance tests: they fail if the lifespan
regresses to `on_event` (the session manager never starts), if the
endpoint moves off the exact path clients are configured with, or if
the loopback-only guarantee slips.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mcp_helpers import call_tool, initialize_params, json_rpc, mcp_client

ENDPOINTS = ["/mcp", "/mcp/", "/mcp/character", "/mcp/logs"]


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import character_archive
    import server

    importlib.reload(character_archive)
    importlib.reload(server)
    # `with` runs the lifespan — which is the whole point here.
    # Host must look like the real sidecar: the MCP endpoints reject
    # anything else, and TestClient defaults to "testserver".
    with TestClient(server.app, base_url="http://127.0.0.1:27384") as c:
        yield c


@pytest.mark.parametrize("path", ENDPOINTS)
def test_endpoint_answers_initialize_on_its_exact_path(
    client: TestClient, path: str
) -> None:
    res = json_rpc(client, path, "initialize", initialize_params())
    assert res.status_code == 200, res.text
    assert res.headers.get("mcp-session-id")
    assert "flist-workbench" in res.text


def test_bare_mcp_path_does_not_redirect(client: TestClient) -> None:
    """Clients are configured with `.../mcp` and not all of them follow
    a 307 on POST, so the exact path must answer directly."""
    res = json_rpc(client, "/mcp", "initialize", initialize_params())
    assert res.status_code == 200
    assert res.history == []


def test_rest_api_still_works_alongside_mcp(client: TestClient) -> None:
    assert client.get("/health").json()["status"] == "ok"


def test_foreign_origin_is_refused(client: TestClient) -> None:
    res = json_rpc(
        client,
        "/mcp",
        "initialize",
        initialize_params(),
        headers={"Origin": "https://evil.example"},
    )
    assert res.status_code == 403


def test_foreign_host_is_refused(client: TestClient) -> None:
    res = json_rpc(
        client,
        "/mcp",
        "initialize",
        initialize_params(),
        headers={"Host": "evil.example"},
    )
    assert res.status_code == 421


def test_localhost_origin_is_allowed(client: TestClient) -> None:
    res = json_rpc(
        client,
        "/mcp",
        "initialize",
        initialize_params(),
        headers={"Origin": "http://localhost:5173"},
    )
    assert res.status_code == 200


def test_mcp_does_not_inherit_the_wildcard_cors_header(
    client: TestClient,
) -> None:
    """The REST API allows any origin; the MCP endpoint must not
    advertise itself as callable from an arbitrary web page."""
    rest = client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert rest.headers.get("access-control-allow-origin") == "*"

    res = json_rpc(
        client,
        "/mcp",
        "initialize",
        initialize_params(),
        headers={"Origin": "http://localhost:5173"},
    )
    assert "access-control-allow-origin" not in res.headers


# ---- lifespan ---------------------------------------------------------


def test_lifespan_runs_every_former_startup_hook(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """FastAPI silently ignores `@app.on_event` once a lifespan exists.
    This asserts the four hooks that were converted still run."""
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FLIST_WORKBENCH_OFFLINE_STARTUP", raising=False)
    import importlib

    import server

    importlib.reload(server)

    called: list[str] = []

    async def _record(name: str) -> None:
        called.append(name)

    for hook in (
        "_eicons_warm_up",
        "_hydrate_activity_log_on_startup",
        "_avatar_cleanup_on_startup",
        "_password_idle_watchdog",
    ):
        monkeypatch.setattr(
            server, hook, (lambda n: lambda: _record(n))(hook)
        )

    with TestClient(server.app):
        pass

    assert called == [
        "_eicons_warm_up",
        "_hydrate_activity_log_on_startup",
        "_avatar_cleanup_on_startup",
        "_password_idle_watchdog",
    ]


def test_no_on_event_hooks_remain() -> None:
    """A hook added back as `@app.on_event` would never fire."""
    source = (Path(__file__).resolve().parents[1] / "server.py").read_text(
        encoding="utf-8"
    )
    assert not re.search(r"^@app\.on_event", source, re.MULTILINE)


# ---- tool surface -----------------------------------------------------


async def test_status_tool_is_listed_on_every_endpoint() -> None:
    for suffix in ("", "character", "logs"):
        async with mcp_client(suffix) as session:
            names = {t.name for t in (await session.list_tools()).tools}
            assert "get_workbench_status" in names


async def test_status_tool_reports_the_data_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    import importlib

    import character_archive
    import paths
    import server

    importlib.reload(paths)
    importlib.reload(character_archive)
    importlib.reload(server)

    async with mcp_client("") as session:
        result, body = await call_tool(session, "get_workbench_status")
        assert not result.isError, body
        assert body["data_dir"] == str(tmp_path)
        assert body["session"]["signed_in"] is False
        assert body["characters"] == []
        assert "never writes to f-list.net" in body["note"]


async def test_every_tool_declares_annotations() -> None:
    """House rule from design §7 — clients use these to decide what to
    auto-approve, so a tool without them is a bug."""
    async with mcp_client("") as session:
        for tool in (await session.list_tools()).tools:
            assert tool.annotations is not None, tool.name
            assert tool.description, tool.name


def test_the_classify_endpoint_is_the_smallest_surface() -> None:
    """Tool schemas are not free. 29 tools on /mcp/logs cost ~5800 tokens
    of context before a single message is judged — half of what a 12k
    client has, which is why one could not fit a batch alongside them.
    Eight tools cost a quarter of that.
    """
    import json

    import workbench_mcp
    from workbench_mcp._registry import registered_tools

    workbench_mcp.build_mcp_servers()

    def schema_bytes(tags):
        return sum(
            len(
                json.dumps(
                    {"name": spec.name, "title": spec.title}, ensure_ascii=False
                )
            )
            + len(spec.fn.__doc__ or "")
            for spec in registered_tools(tags)
        )

    classify = registered_tools(workbench_mcp.ENDPOINTS["classify"])
    logs = registered_tools(workbench_mcp.ENDPOINTS["logs"])
    assert {t.name for t in classify} == {
        "list_log_characters",
        "list_partners",
        "get_label_stats",
        "get_classification_guidelines",
        "get_messages_to_classify",
        "set_message_labels",
        "label_all_unlabeled",
        "ingest_logs",
        "get_job",
    }
    assert len(classify) < len(logs)
    assert schema_bytes(workbench_mcp.ENDPOINTS["classify"]) < 0.5 * schema_bytes(
        workbench_mcp.ENDPOINTS["logs"]
    )


def test_the_classify_endpoint_is_reachable_and_described() -> None:
    import workbench_mcp

    servers = workbench_mcp.build_mcp_servers()
    assert "classify" in servers
    described = workbench_mcp.describe(servers, 27384)
    row = next(
        e for e in described["endpoints"] if e["id"] == "classify"  # type: ignore[index]
    )
    assert row["path"] == "/mcp/classify"
    assert row["tool_count"] == 9
    assert "labelling" in row["label"]
