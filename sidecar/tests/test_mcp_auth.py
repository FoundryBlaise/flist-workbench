"""The optional bearer token on /mcp (design D3).

Off by default on purpose: the endpoints are loopback-only and every
other local process can already reach the REST API unauthenticated, so
requiring a token by default would cost every client a config step and
buy nothing. These tests cover that it stays off, that switching it on
actually gates the endpoint, and that the check happens before a
session can be opened.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mcp_helpers import initialize_params, json_rpc


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import server
    import settings as settings_store

    importlib.reload(settings_store)
    importlib.reload(server)
    with TestClient(server.app, base_url="http://127.0.0.1:27384") as c:
        yield c


def test_no_token_is_required_by_default(client: TestClient) -> None:
    res = json_rpc(client, "/mcp", "initialize", initialize_params())
    assert res.status_code == 200
    assert client.get("/mcp-info").json()["auth"]["required"] is False


def test_issuing_a_token_gates_the_endpoint(client: TestClient) -> None:
    token = client.post("/mcp-info/token").json()["token"]
    assert len(token) > 30

    refused = json_rpc(client, "/mcp", "initialize", initialize_params())
    assert refused.status_code == 401
    # The refusal has to say where to find the token, or the user is
    # stuck with a client that simply stops working.
    assert "Settings" in refused.text
    assert "www-authenticate" in {k.lower() for k in refused.headers}

    allowed = json_rpc(
        client,
        "/mcp",
        "initialize",
        initialize_params(),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert allowed.status_code == 200


def test_the_check_runs_before_a_session_can_be_opened(
    client: TestClient,
) -> None:
    """An unauthenticated caller must not get as far as an MCP session
    id — that would be a usable handle."""
    client.post("/mcp-info/token")
    res = json_rpc(client, "/mcp", "initialize", initialize_params())
    assert res.status_code == 401
    assert "mcp-session-id" not in {k.lower() for k in res.headers}


def test_a_wrong_or_malformed_token_is_refused(client: TestClient) -> None:
    client.post("/mcp-info/token")
    for header in (
        "Bearer wrong",
        "Basic something",
        "",
        "Bearer",
    ):
        res = json_rpc(
            client,
            "/mcp",
            "initialize",
            initialize_params(),
            headers={"Authorization": header},
        )
        assert res.status_code == 401, header


def test_the_token_gates_every_endpoint(client: TestClient) -> None:
    client.post("/mcp-info/token")
    for path in ("/mcp", "/mcp/character", "/mcp/logs"):
        res = json_rpc(client, path, "initialize", initialize_params())
        assert res.status_code == 401, path


def test_revoking_turns_it_back_off(client: TestClient) -> None:
    client.post("/mcp-info/token")
    assert json_rpc(client, "/mcp", "initialize", initialize_params()).status_code == 401

    client.delete("/mcp-info/token")
    assert client.get("/mcp-info").json()["auth"]["required"] is False
    assert json_rpc(client, "/mcp", "initialize", initialize_params()).status_code == 200


def test_reissuing_replaces_the_previous_token(client: TestClient) -> None:
    first = client.post("/mcp-info/token").json()["token"]
    second = client.post("/mcp-info/token").json()["token"]
    assert first != second

    stale = json_rpc(
        client,
        "/mcp",
        "initialize",
        initialize_params(),
        headers={"Authorization": f"Bearer {first}"},
    )
    assert stale.status_code == 401


def test_the_rest_api_is_unaffected(client: TestClient) -> None:
    """The token guards MCP only. The renderer talks to the REST API
    over the same port and has no token."""
    client.post("/mcp-info/token")
    assert client.get("/health").status_code == 200
    assert client.get("/mcp-info").status_code == 200
