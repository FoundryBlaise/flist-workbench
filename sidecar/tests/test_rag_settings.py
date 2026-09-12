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


# ---- /settings/discover-models -----------------------------------------


def test_get_settings_returns_rag_defaults(client: TestClient) -> None:
    import rag as rag_settings

    rag = client.get("/settings").json()["rag"]
    # A fresh install embeds in-process: no endpoint, no key, no prefix
    # — nothing to configure before the first ingest.
    assert rag["embed_model"] == rag_settings.DEFAULT_EMBED_MODEL
    assert "embed_endpoint" not in rag
    assert "embed_api_key" not in rag
    assert "embed_keep_alive" not in rag
    assert rag["defaults"]["embed_model"] == rag_settings.DEFAULT_EMBED_MODEL


def test_put_persists_the_embedding_model(client: TestClient) -> None:
    res = client.put(
        "/settings", json={"rag": {"embed_model": "jinaai/jina-embeddings-v2-base-en"}}
    ).json()
    assert res["rag"]["embed_model"] == "jinaai/jina-embeddings-v2-base-en"
    assert client.get("/settings").json()["rag"]["embed_model"] == (
        "jinaai/jina-embeddings-v2-base-en"
    )


def test_an_endpoint_era_model_id_is_ignored(client: TestClient) -> None:
    """Installs that predate the local backend hold an inference-server
    id here. fastembed cannot load one, and inheriting it would fail at
    ingest time with a puzzling message rather than at read time."""
    import rag as rag_settings
    import settings as settings_store

    conn = settings_store.connect()
    try:
        settings_store.set_value(
            conn, settings_store.KEY_RAG_EMBED_MODEL, "text-embedding-bge-m3"
        )
    finally:
        conn.close()
    assert rag_settings.load_settings().embed_model == (
        rag_settings.DEFAULT_EMBED_MODEL
    )


def test_chunking_follows_the_models_window(client: TestClient) -> None:
    """The model truncates past its window without a word, so the chunk
    size is not the user's to get wrong."""
    import rag as rag_settings

    client.put("/settings", json={"rag": {"chunk_max_chars": 9000}})
    loaded = rag_settings.load_settings()
    cap = rag_settings.rag_embed_local.profile_for(loaded.embed_model).max_chars
    assert loaded.chunk_max_chars == cap
    assert loaded.chunk_soft_split_chars < loaded.chunk_max_chars


def test_rag_test_embedding_reports_the_dimension(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import rag_embed

    monkeypatch.setattr(rag_embed, "probe", lambda s, **k: (384, [0.0] * 384))
    res = client.post("/rag/test-embedding", json={}).json()
    assert res["ok"] is True
    assert res["dimension"] == 384


def test_rag_test_embedding_can_try_a_model_before_it_is_saved(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import rag_embed

    seen: dict[str, Any] = {}

    def fake_probe(settings, **_):
        seen["model"] = settings.embed_model
        return 768, [0.0] * 768

    monkeypatch.setattr(rag_embed, "probe", fake_probe)
    client.post(
        "/rag/test-embedding",
        json={"embed_model": "jinaai/jina-embeddings-v2-base-en"},
    )
    assert seen["model"] == "jinaai/jina-embeddings-v2-base-en"


def test_discover_models_lists_the_local_catalogue(client: TestClient) -> None:
    body = client.post("/settings/discover-models", json={}).json()
    assert body["source"] == "local"
    assert body["error"] is None
    names = [m["model"] for m in body["models"]]
    assert "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" in names
    # Dimension, size and licence are what the choice turns on — the
    # catalogue mixes apache-2.0 and MIT with cc-by-nc-4.0.
    first = body["models"][0]
    assert {"model", "dimension", "size_gb", "license"} <= set(first)
