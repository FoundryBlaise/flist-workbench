"""The app learns which extension version the browser is running.

Workbench ships the extension as an unpacked folder. Chrome reads that
folder once per browser start, so right after an app update the files
on disk are newer than what the browser runs, and only the extension
itself can say which version that is. It does, in a header on every
authenticated call.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import restore as restore_svc
    import server

    importlib.reload(restore_svc)
    hs = restore_svc.begin_handshake()
    restore_svc.accept_handshake(hs["handshake_id"])
    c = TestClient(server.app)
    c.token = hs["token"]  # type: ignore[attr-defined]
    return c


def test_nothing_reported_before_the_extension_calls(client: TestClient) -> None:
    assert client.get("/restore/extension").json() == {"version": None, "seen_at": None}


def test_authenticated_call_records_the_version(client: TestClient) -> None:
    res = client.get(
        "/restore/characters",
        headers={
            "X-Workbench-Auth": client.token,  # type: ignore[attr-defined]
            "X-Workbench-Extension-Version": "0.1.1",
        },
    )
    assert res.status_code == 200
    seen = client.get("/restore/extension").json()
    assert seen["version"] == "0.1.1"
    assert seen["seen_at"] is not None


def test_unauthenticated_call_cannot_plant_a_version(client: TestClient) -> None:
    res = client.get(
        "/restore/characters",
        headers={"X-Workbench-Extension-Version": "9.9.9"},
    )
    assert res.status_code == 401
    assert client.get("/restore/extension").json()["version"] is None


def test_an_older_extension_without_the_header_changes_nothing(client: TestClient) -> None:
    token = client.token  # type: ignore[attr-defined]
    client.get(
        "/restore/characters",
        headers={"X-Workbench-Auth": token, "X-Workbench-Extension-Version": "0.1.1"},
    )
    client.get("/restore/characters", headers={"X-Workbench-Auth": token})
    assert client.get("/restore/extension").json()["version"] == "0.1.1"
