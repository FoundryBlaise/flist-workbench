"""HTTP tests for /flist/mapping-list and /flist/character/{id}/working.

The fetcher is monkeypatched — no live HTTP. The cache file is written
via the patched fetcher so the endpoint's etag + fetched_at decoration
exercises real disk paths.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    from server import app

    return TestClient(app)


# ---- /flist/mapping-list ----------------------------------------------


def _stub_fetcher(monkeypatch: pytest.MonkeyPatch, payload: dict[str, Any]):
    """Patch flist_api.fetch_mapping_list to write `payload` to its cache
    path and return it. Records the kwargs each call received so tests
    can assert force=True propagation without touching the real fetcher.
    """
    import flist_api

    calls: list[dict[str, Any]] = []

    async def _stub(cache_path: Path, *, client=None, ttl_sec=None, force: bool = False):
        calls.append({"force": force, "cache_path": str(cache_path)})
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(payload), encoding="utf-8")
        return payload

    monkeypatch.setattr(flist_api, "fetch_mapping_list", _stub)
    return calls


def test_mapping_list_returns_cached_payload_with_etag(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = {"infotags": [{"id": 9, "name": "Species"}], "listitems": []}
    _stub_fetcher(monkeypatch, payload)
    res = client.get("/flist/mapping-list")
    assert res.status_code == 200
    body = res.json()
    assert body["infotags"][0]["name"] == "Species"
    assert isinstance(body["_etag"], str) and len(body["_etag"]) == 64
    assert isinstance(body["_fetched_at"], int)


def test_mapping_list_force_true_threads_into_fetcher(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _stub_fetcher(monkeypatch, {"infotags": [], "listitems": []})
    client.get("/flist/mapping-list")
    client.get("/flist/mapping-list?force=true")
    assert calls[0]["force"] is False
    assert calls[1]["force"] is True


def test_mapping_list_propagates_ticket_required_as_401(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import flist_api

    async def _raise(cache_path, *, client=None, ttl_sec=None, force=False):
        raise flist_api.TicketRequired("not signed in")

    monkeypatch.setattr(flist_api, "fetch_mapping_list", _raise)
    res = client.get("/flist/mapping-list")
    assert res.status_code == 401
