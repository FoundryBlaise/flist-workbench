from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    from server import app

    return TestClient(app)


def test_get_settings_returns_rag_defaults(client: TestClient) -> None:
    import rag as rag_settings

    body = client.get("/settings").json()
    assert "rag" in body
    rag = body["rag"]
    assert rag["embed_endpoint"] == rag_settings.DEFAULT_EMBED_ENDPOINT
    assert rag["embed_model"] == rag_settings.DEFAULT_EMBED_MODEL
    assert rag["embed_api_key"] == rag_settings.DEFAULT_EMBED_API_KEY
    assert rag["embed_query_prefix"] == rag_settings.DEFAULT_EMBED_QUERY_PREFIX
    assert rag["embed_document_prefix"] == rag_settings.DEFAULT_EMBED_DOCUMENT_PREFIX
    assert rag["defaults"]["embed_model"] == rag_settings.DEFAULT_EMBED_MODEL


def test_put_persists_rag_settings(client: TestClient) -> None:
    res = client.put(
        "/settings",
        json={
            "rag": {
                "embed_endpoint": "http://example.test/v1",
                "embed_model": "my-embed",
                "embed_api_key": "sk-test",
                "embed_query_prefix": "search_query: ",
                "embed_document_prefix": "search_document: ",
            }
        },
    ).json()
    assert res["rag"]["embed_endpoint"] == "http://example.test/v1"
    assert res["rag"]["embed_model"] == "my-embed"
    assert res["rag"]["embed_api_key"] == "sk-test"
    assert res["rag"]["embed_query_prefix"] == "search_query: "
    assert res["rag"]["embed_document_prefix"] == "search_document: "

    # Re-read GET to confirm persistence across calls.
    res2 = client.get("/settings").json()
    assert res2["rag"]["embed_endpoint"] == "http://example.test/v1"


def test_put_clears_rag_field_with_empty_string(client: TestClient) -> None:
    import rag as rag_settings

    client.put("/settings", json={"rag": {"embed_endpoint": "http://x.test/v1"}})
    res = client.put("/settings", json={"rag": {"embed_endpoint": ""}}).json()
    assert res["rag"]["embed_endpoint"] == rag_settings.DEFAULT_EMBED_ENDPOINT


def test_rag_test_embedding_success(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Patch rag_embed.probe so we don't talk to a real LM Studio."""
    import rag_embed

    captured: dict[str, Any] = {}

    def fake_probe(settings, *, timeout=30.0):
        captured["settings"] = settings
        captured["timeout"] = timeout
        return 768, [0.0] * 768

    monkeypatch.setattr(rag_embed, "probe", fake_probe)
    res = client.post(
        "/rag/test-embedding",
        json={
            "embed_endpoint": "http://example.test/v1",
            "embed_model": "test-model",
            "embed_api_key": "",
        },
    ).json()
    assert res["ok"] is True
    assert res["dimension"] == 768
    assert res["model"] == "test-model"
    assert res["error"] is None
    assert "elapsed_ms" in res
    # The patched probe should have received the overrides, not the
    # stored defaults — that's the whole point of the body payload.
    assert captured["settings"].embed_endpoint == "http://example.test/v1"
    assert captured["settings"].embed_model == "test-model"


def test_rag_test_embedding_uses_saved_when_body_omits(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import rag_embed

    client.put(
        "/settings",
        json={
            "rag": {
                "embed_endpoint": "http://saved.test/v1",
                "embed_model": "saved-model",
            }
        },
    )

    captured: dict[str, Any] = {}

    def fake_probe(settings, *, timeout=30.0):
        captured["settings"] = settings
        return 1024, [0.0] * 1024

    monkeypatch.setattr(rag_embed, "probe", fake_probe)
    res = client.post("/rag/test-embedding", json={}).json()
    assert res["ok"] is True
    assert res["dimension"] == 1024
    assert captured["settings"].embed_endpoint == "http://saved.test/v1"
    assert captured["settings"].embed_model == "saved-model"


def test_rag_test_embedding_handles_embed_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import rag_embed

    def boom(settings, *, timeout=30.0):
        raise rag_embed.EmbedError("HTTP 404: model not loaded")

    monkeypatch.setattr(rag_embed, "probe", boom)
    res = client.post("/rag/test-embedding", json={}).json()
    assert res["ok"] is False
    assert res["dimension"] is None
    assert "model not loaded" in res["error"]


def test_rag_test_embedding_handles_unexpected_exception(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import rag_embed

    def crash(settings, *, timeout=30.0):
        raise RuntimeError("boom")

    monkeypatch.setattr(rag_embed, "probe", crash)
    res = client.post("/rag/test-embedding", json={}).json()
    assert res["ok"] is False
    assert "RuntimeError" in res["error"]
    assert "boom" in res["error"]
