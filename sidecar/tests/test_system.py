"""Tests for the AI Setup wizard's sidecar surface — system module + routes."""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    from server import app

    return TestClient(app)


class _FakeResp(io.BytesIO):
    """Minimal urlopen() replacement supporting context-manager + iter."""

    def __init__(self, body: bytes):
        super().__init__(body)
        self.status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
        return False


def _ok_response(payload: dict) -> _FakeResp:
    return _FakeResp(json.dumps(payload).encode("utf-8"))


# ---- ollama_status -----------------------------------------------------


def test_ollama_status_running(monkeypatch: pytest.MonkeyPatch) -> None:
    import system as system_mod

    def fake_urlopen(req, timeout):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        if url.endswith("/api/tags"):
            return _ok_response(
                {"models": [{"name": "gemma:12b"}, {"name": "nomic-embed-text:latest"}]}
            )
        if url.endswith("/api/version"):
            return _ok_response({"version": "0.4.1"})
        raise AssertionError(f"unexpected url: {url}")

    monkeypatch.setattr(system_mod, "urlopen", fake_urlopen)
    s = system_mod.ollama_status()
    assert s.running is True
    assert s.installed is True
    assert s.version == "0.4.1"
    assert s.models == ["gemma:12b", "nomic-embed-text:latest"]
    assert s.error is None


def test_ollama_status_running_without_version_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Older Ollama versions omit /api/version. Don't crash."""
    import system as system_mod
    from urllib.error import HTTPError

    def fake_urlopen(req, timeout):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        if url.endswith("/api/tags"):
            return _ok_response({"models": []})
        raise HTTPError(url, 404, "Not Found", {}, None)

    monkeypatch.setattr(system_mod, "urlopen", fake_urlopen)
    s = system_mod.ollama_status()
    assert s.running is True
    assert s.version is None
    assert s.models == []
    assert s.error is None


def test_ollama_status_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    import system as system_mod
    from urllib.error import URLError

    def fake_urlopen(req, timeout):
        raise URLError("Connection refused")

    monkeypatch.setattr(system_mod, "urlopen", fake_urlopen)
    # Pretend winget probe returns False so we test the pure-no-Ollama path.
    monkeypatch.setattr(system_mod, "_winget_has_ollama", lambda: False)
    s = system_mod.ollama_status()
    assert s.running is False
    assert s.installed is False
    assert s.models is None
    assert "isn't responding" in s.error


def test_ollama_status_installed_but_not_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import system as system_mod
    from urllib.error import URLError

    monkeypatch.setattr(
        system_mod,
        "urlopen",
        lambda *_a, **_k: (_ for _ in ()).throw(URLError("refused")),
    )
    monkeypatch.setattr(system_mod, "_winget_has_ollama", lambda: True)
    s = system_mod.ollama_status()
    assert s.running is False
    assert s.installed is True


# ---- /system/ollama-status route ---------------------------------------


def test_get_ollama_status_route(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import system as system_mod

    fake = system_mod.OllamaStatus(
        running=True,
        installed=True,
        version="0.4.1",
        models=["llama3:8b"],
        error=None,
    )
    monkeypatch.setattr(system_mod, "ollama_status", lambda *a, **kw: fake)
    res = client.get("/system/ollama-status").json()
    assert res == {
        "running": True,
        "installed": True,
        "version": "0.4.1",
        "models": ["llama3:8b"],
        "error": None,
    }


# ---- ollama_pull_stream ------------------------------------------------


def test_ollama_pull_stream_yields_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import system as system_mod

    ndjson = (
        b'{"status":"pulling manifest"}\n'
        b'{"status":"downloading","digest":"sha256:a","total":100,"completed":40}\n'
        b'{"status":"downloading","digest":"sha256:a","total":100,"completed":100}\n'
        b'\n'  # empty line should be skipped, not abort
        b'{"status":"success"}\n'
    )

    monkeypatch.setattr(system_mod, "urlopen", lambda *a, **kw: _FakeResp(ndjson))
    events = list(system_mod.ollama_pull_stream("test-model"))
    statuses = [e["status"] for e in events]
    assert statuses == [
        "pulling manifest",
        "downloading",
        "downloading",
        "success",
    ]


def test_ollama_pull_stream_skips_garbage_lines(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import system as system_mod

    ndjson = (
        b'{"status":"pulling manifest"}\n'
        b'not actually json\n'
        b'{"status":"success"}\n'
    )
    monkeypatch.setattr(system_mod, "urlopen", lambda *a, **kw: _FakeResp(ndjson))
    events = list(system_mod.ollama_pull_stream("test-model"))
    assert [e["status"] for e in events] == ["pulling manifest", "success"]


# ---- /system/ollama-pull SSE route -------------------------------------


def test_pull_route_streams_sse_then_done(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import system as system_mod

    def fake_stream(name, **kw):
        yield {"status": "pulling manifest"}
        yield {"status": "downloading", "digest": "sha:a", "total": 10, "completed": 5}
        yield {"status": "success"}

    monkeypatch.setattr(system_mod, "ollama_pull_stream", fake_stream)
    with client.stream(
        "POST", "/system/ollama-pull", json={"name": "test-model"}
    ) as resp:
        text = b"".join(resp.iter_bytes()).decode("utf-8")
    # Three progress events + one done.
    assert text.count("event: progress") == 3
    assert text.count("event: done") == 1
    # 'completed' field flows through verbatim.
    assert '"completed": 5' in text


def test_pull_route_emits_error_when_ollama_throws(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import system as system_mod
    from urllib.error import URLError

    def fake_stream(name, **kw):
        yield {"status": "pulling manifest"}
        raise URLError("Connection refused")

    monkeypatch.setattr(system_mod, "ollama_pull_stream", fake_stream)
    with client.stream(
        "POST", "/system/ollama-pull", json={"name": "test-model"}
    ) as resp:
        text = b"".join(resp.iter_bytes()).decode("utf-8")
    assert "event: error" in text
    assert "Connection refused" in text


def test_pull_route_emits_error_when_stream_ends_without_success(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import system as system_mod

    def fake_stream(name, **kw):
        yield {"status": "pulling manifest"}
        # No success — generator just stops.

    monkeypatch.setattr(system_mod, "ollama_pull_stream", fake_stream)
    with client.stream(
        "POST", "/system/ollama-pull", json={"name": "test-model"}
    ) as resp:
        text = b"".join(resp.iter_bytes()).decode("utf-8")
    assert "event: error" in text
    assert "without success" in text
