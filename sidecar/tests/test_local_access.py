"""The sidecar answers only the app window and the paired extension.

Loopback is not access control: every page open in the user's browser
can reach 127.0.0.1:27384, and a DNS-rebinding page can even send the
right-looking requests from its own origin. These tests drive the whole
ASGI stack from outside, the way such a page or the real callers would
(ADR 0002):

- the app window carries the launch secret Electron generated;
- the extension carries its pairing token, from its background worker
  (`chrome-extension://` origin) or its content script on f-list.net;
- MCP clients carry their own optional bearer and are not touched here;
- everyone else gets nothing.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.local_access import RENDERER_ORIGIN_ENV, SECRET_ENV
from sidecar_client import (
    BASE_URL,
    SECRET_HEADER,
    Route,
    api_routes,
    app_client,
    error_code,
    sweep,
)

EVIL = "https://evil.example"
FLIST = "https://www.f-list.net"
EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
#: The origin of the built app window (electron/appPage.ts).
APP_ORIGIN = "app://workbench"

#: Callable with no credential at all.
OPEN_ROUTES = {
    ("GET", "/health"),
    ("POST", "/restore/handshake"),
    ("GET", "/restore/handshake-status"),
}

#: The extension's own routes: its pairing token, never the launch secret.
EXTENSION_ROUTES = {
    ("GET", "/restore/characters"),
    ("GET", "/restore/snapshots"),
    ("GET", "/restore/snapshot/{snapshot_id}"),
    ("POST", "/restore/snapshot/fresh"),
    ("POST", "/restore/image-ids"),
    ("POST", "/restore/saved"),
    ("POST", "/restore/done"),
}


@pytest.fixture
def server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN201
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import restore as restore_svc
    import server as server_module

    importlib.reload(restore_svc)
    yield server_module
    # The pairing lives in module state; leave the next test unpaired.
    restore_svc.revoke_token()


@pytest.fixture
def stranger(server) -> TestClient:  # noqa: ANN001
    """Right Host, no credential: a rebinding page or a curious script."""
    return TestClient(server.app, base_url=BASE_URL)


@pytest.fixture
def app_window(server) -> TestClient:  # noqa: ANN001
    return app_client(server.app)


@pytest.fixture
def pairing_token(app_window: TestClient) -> str:
    """Pair the way it happens for real: the extension starts, the app
    window accepts."""
    begun = TestClient(app_window.app, base_url=BASE_URL).post(
        "/restore/handshake", headers={"Origin": EXTENSION}
    )
    assert begun.status_code == 200, begun.text
    accepted = app_window.post(
        "/restore/handshake/accept",
        json={"handshake_id": begun.json()["handshake_id"]},
    )
    assert accepted.json() == {"ok": True}
    return begun.json()["token"]


# ---- the launch secret --------------------------------------------------


def test_every_app_route_refuses_a_caller_without_the_launch_secret(
    server, stranger: TestClient  # noqa: ANN001
) -> None:
    """Enumerated from the app, so a route added later is covered too."""
    routes = [
        route
        for route in api_routes(server.app)
        if (route.method, route.path) not in OPEN_ROUTES | EXTENSION_ROUTES
    ]
    assert len(routes) > 80
    let_through = sweep(
        stranger,
        routes,
        lambda res: res.status_code == 401 and error_code(res) == "unauthorized",
    )
    assert let_through == []


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/mcp-info"),
        ("POST", "/mcp-info/token"),
        ("GET", "/events"),
        ("GET", "/openapi.json"),
        ("GET", "/docs"),
    ],
)
def test_routes_outside_the_api_list_also_need_the_secret(
    stranger: TestClient, method: str, path: str
) -> None:
    res = stranger.request(method, path)
    assert res.status_code == 401


def test_a_wrong_secret_is_refused(stranger: TestClient) -> None:
    res = stranger.get("/settings", headers={SECRET_HEADER: "guess"})
    assert res.status_code == 401
    assert res.json()["code"] == "unauthorized"


def test_the_app_window_gets_through(app_window: TestClient) -> None:
    assert app_window.get("/settings").status_code == 200


def test_health_is_open_and_says_only_ok_and_version(stranger: TestClient) -> None:
    res = stranger.get("/health")
    assert res.status_code == 200
    assert set(res.json()) == {"status", "version"}


def test_without_a_configured_secret_nothing_gets_through(
    server, monkeypatch: pytest.MonkeyPatch  # noqa: ANN001
) -> None:
    """Fail closed: an empty secret must not match an empty header."""
    monkeypatch.delenv(SECRET_ENV)
    client = TestClient(server.app, base_url=BASE_URL)
    assert client.get("/settings", headers={SECRET_HEADER: ""}).status_code == 401
    assert client.get("/settings").status_code == 401


def test_the_sidecar_refuses_to_start_without_a_secret(
    server, monkeypatch: pytest.MonkeyPatch  # noqa: ANN001
) -> None:
    monkeypatch.delenv(SECRET_ENV)
    with pytest.raises(RuntimeError, match=SECRET_ENV):
        with TestClient(server.app, base_url=BASE_URL):
            pass


# ---- Host --------------------------------------------------------------


@pytest.mark.parametrize("path", ["/settings", "/health", "/restore/handshake", "/mcp"])
def test_a_foreign_host_is_refused_on_every_route(
    app_window: TestClient, path: str
) -> None:
    """DNS rebinding: evil.example resolving to 127.0.0.1 still sends
    its own name as Host."""
    res = app_window.post(path, headers={"Host": "evil.example"})
    assert res.status_code == 403
    assert res.json()["code"] == "forbidden_host"


def test_a_foreign_port_in_the_host_is_refused(app_window: TestClient) -> None:
    res = app_window.get("/settings", headers={"Host": "127.0.0.1:8080"})
    assert res.status_code == 403


def test_localhost_by_name_is_accepted(app_window: TestClient) -> None:
    res = app_window.get("/settings", headers={"Host": "localhost:27384"})
    assert res.status_code == 200


# ---- Origin and CORS -----------------------------------------------------


def test_a_foreign_origin_is_refused_even_with_the_secret(
    app_window: TestClient,
) -> None:
    res = app_window.get("/settings", headers={"Origin": EVIL})
    assert res.status_code == 403
    assert res.json()["code"] == "forbidden_origin"
    assert "access-control-allow-origin" not in res.headers


def test_the_app_window_origin_is_granted(app_window: TestClient) -> None:
    """The built window loads from `app://workbench`, an origin of its own."""
    res = app_window.get("/settings", headers={"Origin": APP_ORIGIN})
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == APP_ORIGIN


def test_the_app_window_origin_without_the_secret_is_refused(
    stranger: TestClient,
) -> None:
    res = stranger.get("/settings", headers={"Origin": APP_ORIGIN})
    assert res.status_code == 401
    assert res.json()["code"] == "unauthorized"


def test_a_preflight_from_the_app_window_origin_needs_no_secret(
    stranger: TestClient,
) -> None:
    res = stranger.options(
        "/flist/character/1/working",
        headers={
            "Origin": APP_ORIGIN,
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "content-type,if-match",
        },
    )
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == APP_ORIGIN
    assert "PUT" in res.headers["access-control-allow-methods"]
    assert "if-match" in res.headers["access-control-allow-headers"].lower()


@pytest.mark.parametrize(
    "origin", ["app://evil", "app://workbench.evil", "app://workbench:1", "APP://WORKBENCH"]
)
def test_only_the_exact_app_window_origin_is_granted(
    app_window: TestClient, origin: str
) -> None:
    res = app_window.get("/settings", headers={"Origin": origin})
    assert res.status_code == 403
    assert "access-control-allow-origin" not in res.headers


#: Routes the API list leaves out; they sit behind the same guard.
UNLISTED_ROUTES = [
    Route("GET", "/events"),
    Route("GET", "/mcp-info"),
    Route("POST", "/mcp-info/token"),
    Route("GET", "/openapi.json"),
    Route("GET", "/docs"),
    Route("POST", "/mcp"),
]


def _refused_origin(res) -> bool:  # noqa: ANN001
    return (
        res.status_code == 403
        and error_code(res) == "forbidden_origin"
        and "access-control-allow-origin" not in res.headers
    )


def test_origin_null_is_refused_on_every_route(server) -> None:  # noqa: ANN001
    """`Origin: null` is what a sandboxed iframe on any site sends. The
    app window has an origin of its own, so nothing that may call the
    sidecar sends `null`: not even the launch secret lets it in."""
    client = app_client(server.app, headers={"Origin": "null"})
    routes = [*api_routes(server.app), *UNLISTED_ROUTES]
    assert len(routes) > 80
    let_through = sweep(client, routes, _refused_origin, json={})
    assert let_through == []


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("PUT", "/flist/character/1/working"),
        ("GET", "/settings"),
        ("POST", "/restore/handshake"),
        ("GET", "/restore/handshake-status"),
        ("GET", "/restore/characters"),
    ],
)
def test_a_preflight_from_origin_null_gets_no_grant(
    stranger: TestClient, method: str, path: str
) -> None:
    res = stranger.options(
        path,
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "content-type,x-workbench-auth",
        },
    )
    assert _refused_origin(res)
    assert set(res.json()) == {"code", "message"}


def test_a_preflight_from_a_foreign_origin_gets_no_grant(stranger: TestClient) -> None:
    res = stranger.options(
        "/settings",
        headers={"Origin": EVIL, "Access-Control-Request-Method": "PUT"},
    )
    assert res.status_code == 403
    assert "access-control-allow-origin" not in res.headers


def test_the_dev_server_origin_is_granted_only_when_configured(
    app_window: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    dev = "http://localhost:5173"
    assert app_window.get("/settings", headers={"Origin": dev}).status_code == 403
    monkeypatch.setenv(RENDERER_ORIGIN_ENV, dev)
    res = app_window.get("/settings", headers={"Origin": dev})
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == dev


@pytest.mark.parametrize("origin", [FLIST, EXTENSION])
def test_extension_origins_do_not_reach_app_routes(
    app_window: TestClient, origin: str
) -> None:
    res = app_window.get("/settings", headers={"Origin": origin})
    assert res.status_code == 403


# ---- pairing -------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", "/restore/handshake/pending", None),
        ("POST", "/restore/handshake/accept", {"handshake_id": "x"}),
        ("POST", "/restore/handshake/reject", {"handshake_id": "x"}),
        ("DELETE", "/restore/token", None),
        ("GET", "/restore/extension", None),
    ],
)
def test_only_the_app_window_manages_pairing(
    stranger: TestClient, pairing_token: str, method: str, path: str, body
) -> None:  # noqa: ANN001
    """Not even the paired extension may approve a pairing."""
    res = stranger.request(
        method, path, json=body, headers={"X-Workbench-Auth": pairing_token}
    )
    assert res.status_code == 401


def test_a_page_cannot_approve_its_own_pairing(stranger: TestClient) -> None:
    begun = stranger.post("/restore/handshake", headers={"Origin": EXTENSION}).json()
    res = stranger.post(
        "/restore/handshake/accept",
        json={"handshake_id": begun["handshake_id"]},
        headers={"Origin": APP_ORIGIN},
    )
    assert res.status_code == 401
    status = stranger.get(
        "/restore/handshake-status", params={"handshake_id": begun["handshake_id"]}
    )
    assert status.json() == {"status": "pending"}


def test_a_foreign_page_cannot_start_a_handshake(stranger: TestClient) -> None:
    res = stranger.post("/restore/handshake", headers={"Origin": EVIL})
    assert res.status_code == 403


@pytest.mark.parametrize("caller", ["stranger", "app_window"])
def test_the_app_window_origin_cannot_start_a_handshake(
    request: pytest.FixtureRequest, app_window: TestClient, caller: str
) -> None:
    """Only the extension starts a pairing, so not even the app window's
    own origin is let in here."""
    client: TestClient = request.getfixturevalue(caller)
    res = client.post("/restore/handshake", headers={"Origin": APP_ORIGIN})
    assert res.status_code == 403
    assert set(res.json()) == {"code", "message"}
    assert res.json()["code"] == "forbidden_origin"
    assert "access-control-allow-origin" not in res.headers
    assert app_window.get("/restore/handshake/pending").json() == {"pending": []}


def test_a_preflight_from_the_app_window_origin_gets_no_handshake_grant(
    stranger: TestClient,
) -> None:
    res = stranger.options(
        "/restore/handshake",
        headers={"Origin": APP_ORIGIN, "Access-Control-Request-Method": "POST"},
    )
    assert res.status_code == 403
    assert "access-control-allow-origin" not in res.headers


@pytest.mark.parametrize("origin", [FLIST, EXTENSION])
def test_the_extension_starts_a_handshake_from_its_origins(
    stranger: TestClient, app_window: TestClient, origin: str
) -> None:
    res = stranger.post("/restore/handshake", headers={"Origin": origin})
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == origin
    pending = app_window.get("/restore/handshake/pending").json()["pending"]
    assert [p["handshake_id"] for p in pending] == [res.json()["handshake_id"]]


@pytest.mark.parametrize(("method", "path"), sorted(EXTENSION_ROUTES))
def test_extension_routes_want_the_pairing_token_not_the_secret(
    app_window: TestClient, method: str, path: str
) -> None:
    res = app_window.request(method, Route(method, path).url(), json={})
    assert res.status_code == 401


# ---- extension 0.1.1, replayed ----------------------------------------------
#
# The exact requests the released extension sends. Its background worker
# fetches with host permission from a chrome-extension:// origin; its
# content script fetches from f-list.net, and because of the custom
# header the browser preflights those first.


def _extension_headers(token: str) -> dict[str, str]:
    return {"X-Workbench-Auth": token, "X-Workbench-Extension-Version": "0.1.1"}


def test_extension_0_1_1_pairs_from_its_background_worker(
    stranger: TestClient, app_window: TestClient
) -> None:
    begun = stranger.post("/restore/handshake", headers={"Origin": EXTENSION})
    assert begun.status_code == 200
    handshake_id = begun.json()["handshake_id"]
    poll = stranger.get(
        "/restore/handshake-status",
        params={"handshake_id": handshake_id},
        headers={"Origin": EXTENSION},
    )
    assert poll.json() == {"status": "pending"}

    assert app_window.get("/restore/handshake/pending").json()["pending"]
    app_window.post("/restore/handshake/accept", json={"handshake_id": handshake_id})

    poll = stranger.get(
        "/restore/handshake-status",
        params={"handshake_id": handshake_id},
        headers={"Origin": EXTENSION},
    )
    assert poll.json() == {"status": "accepted"}


@pytest.mark.parametrize(
    ("method", "path", "body", "passed"),
    [
        ("GET", "/restore/characters", None, {200}),
        ("GET", "/restore/snapshots?character=Someone", None, {200}),
        ("GET", "/restore/snapshot/nothing.zip?character=Someone", None, {404}),
        # An empty body proves the request got past the gate without
        # making the route do anything.
        ("POST", "/restore/snapshot/fresh", {}, {422}),
        ("POST", "/restore/image-ids", {}, {422}),
        ("POST", "/restore/saved", {}, {422}),
        ("POST", "/restore/done", {}, {200}),
    ],
)
def test_extension_0_1_1_background_worker_calls_get_through(
    stranger: TestClient,
    pairing_token: str,
    method: str,
    path: str,
    body,  # noqa: ANN001
    passed: set[int],
) -> None:
    res = stranger.request(
        method,
        path,
        json=body,
        headers={"Origin": EXTENSION, **_extension_headers(pairing_token)},
    )
    assert res.status_code in passed, res.text


@pytest.mark.parametrize(
    "path",
    [
        "/restore/characters",
        "/restore/snapshots?character=Someone",
        "/restore/snapshot/nothing.zip?character=Someone",
    ],
)
def test_extension_0_1_1_content_script_calls_get_through(
    stranger: TestClient, pairing_token: str, path: str
) -> None:
    preflight = stranger.options(
        path,
        headers={
            "Origin": FLIST,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-workbench-auth",
        },
    )
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == FLIST
    assert "x-workbench-auth" in preflight.headers["access-control-allow-headers"].lower()

    res = stranger.get(path, headers={"Origin": FLIST, "X-Workbench-Auth": pairing_token})
    assert res.status_code in {200, 404}
    assert res.headers["access-control-allow-origin"] == FLIST


def test_a_foreign_page_gets_no_grant_on_extension_routes(
    stranger: TestClient, pairing_token: str
) -> None:
    """Even holding a stolen token, a page cannot read the response."""
    res = stranger.get(
        "/restore/characters",
        headers={"Origin": EVIL, "X-Workbench-Auth": pairing_token},
    )
    assert res.status_code == 403
    assert "access-control-allow-origin" not in res.headers


# ---- MCP ---------------------------------------------------------------------


def test_mcp_clients_need_no_launch_secret(server) -> None:  # noqa: ANN001
    """Client configs written before this change keep working."""
    import importlib

    from mcp_helpers import initialize_params, json_rpc

    # A session manager runs once per instance; a fresh module brings
    # fresh ones, as the MCP mount tests do.
    importlib.reload(server)
    with TestClient(server.app, base_url=BASE_URL) as client:
        res = json_rpc(client, "/mcp", "initialize", initialize_params())
    assert res.status_code == 200, res.text
