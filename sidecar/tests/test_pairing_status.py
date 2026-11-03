"""Settings asks the sidecar whether the browser extension is paired.

The renderer never holds the pairing token, so it cannot find out by
trying the extension's routes. `GET /pairing` tells the app window
whether a token is stored, and nothing more: the token itself never
leaves the sidecar, and only the launch secret opens the route, so no
page learns whether the user runs the extension (ADR 0002).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sidecar_client import BASE_URL, app_client

EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"


@pytest.fixture
def server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN201
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    from services import upload as upload_service
    import server as server_module

    importlib.reload(upload_service)
    yield server_module
    # The pairing lives in module state; leave the next test unpaired.
    upload_service.revoke_token()


@pytest.fixture
def extension(server) -> TestClient:  # noqa: ANN001
    """The extension's background worker: no launch secret."""
    return TestClient(server.app, base_url=BASE_URL, headers={"Origin": EXTENSION})


@pytest.fixture
def app_window(server) -> TestClient:  # noqa: ANN001
    return app_client(server.app)


def _pair(extension: TestClient, app_window: TestClient) -> str:
    """Pair the way it happens for real: the extension starts, the app
    window accepts. Returns the token the extension now holds."""
    begun = extension.post("/restore/handshake")
    assert begun.status_code == 200, begun.text
    accepted = app_window.post(
        "/restore/handshake/accept",
        json={"handshake_id": begun.json()["handshake_id"]},
    )
    assert accepted.json() == {"ok": True}
    return begun.json()["token"]


def test_a_caller_without_the_launch_secret_is_refused(server) -> None:  # noqa: ANN001
    stranger = TestClient(server.app, base_url=BASE_URL)
    res = stranger.get("/pairing")
    assert res.status_code == 401
    assert res.json()["code"] == "unauthorized"


def test_the_pairing_token_does_not_open_it(
    extension: TestClient, app_window: TestClient
) -> None:
    token = _pair(extension, app_window)
    res = TestClient(extension.app, base_url=BASE_URL).get(
        "/pairing", headers={"X-Workbench-Auth": token}
    )
    assert res.status_code == 401


def test_not_paired_before_any_pairing(app_window: TestClient) -> None:
    res = app_window.get("/pairing")
    assert res.status_code == 200
    assert res.json() == {"paired": False}


def test_a_pending_handshake_is_not_a_pairing(
    extension: TestClient, app_window: TestClient
) -> None:
    assert extension.post("/restore/handshake").status_code == 200
    assert app_window.get("/pairing").json() == {"paired": False}


def test_paired_after_accept_and_the_token_never_appears(
    extension: TestClient, app_window: TestClient
) -> None:
    token = _pair(extension, app_window)
    res = app_window.get("/pairing")
    assert res.json() == {"paired": True}
    assert token not in res.text


def test_not_paired_after_revoke(
    extension: TestClient, app_window: TestClient
) -> None:
    _pair(extension, app_window)
    assert app_window.delete("/restore/token").json() == {"ok": True}
    assert app_window.get("/pairing").json() == {"paired": False}


def test_rotating_locks_out_the_previously_paired_extension(
    extension: TestClient, app_window: TestClient
) -> None:
    token = _pair(extension, app_window)
    before = extension.get("/restore/characters", headers={"X-Workbench-Auth": token})
    assert before.status_code == 200

    app_window.delete("/restore/token")

    after = extension.get("/restore/characters", headers={"X-Workbench-Auth": token})
    assert after.status_code == 401
