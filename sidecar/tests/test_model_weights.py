"""Switching the embedding or reranker model removes the old weights.

fastembed downloads each model into the app's model folder, and a
reranker is over a gigabyte. Weights are a download cache, not user
data, so the ones the settings no longer name go directly, not to the
Trash. Every test points the app at a temporary data folder and fills
its model folder with fake weight folders: none of them may ever reach
the real one.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from refusals import IndexBusy
from services import index, jobs
from services import settings as settings_service

#: Folders named the way fastembed's Hugging Face download names them.
DEFAULT_EMBED = "models--qdrant--paraphrase-multilingual-MiniLM-L12-v2-onnx-Q"
MPNET_EMBED = "models--xenova--paraphrase-multilingual-mpnet-base-v2"
DEFAULT_RERANK = "models--jinaai--jina-reranker-v2-base-multilingual"
BGE_RERANK = "models--BAAI--bge-reranker-base"


@pytest.fixture
def models(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A temporary model folder holding fake weights of the defaults."""
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "data"))
    folder = tmp_path / "data" / "models"
    for name in (DEFAULT_EMBED, DEFAULT_RERANK):
        _fake_weights(folder, name)
    return folder


def _fake_weights(models: Path, name: str) -> None:
    snapshot = models / name / "snapshots" / "abc123"
    snapshot.mkdir(parents=True)
    (snapshot / "model.onnx").write_bytes(b"not really a model")


def _folders(models: Path) -> set[str]:
    return {p.name for p in models.iterdir() if p.is_dir()}


def test_changing_the_embedding_model_removes_the_old_weights(models: Path) -> None:
    settings_service.update(
        {"rag.embed_model": "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"}
    )

    assert DEFAULT_EMBED not in _folders(models)
    assert DEFAULT_RERANK in _folders(models)


def test_changing_the_reranker_removes_the_old_weights(models: Path) -> None:
    (models / ".locks" / DEFAULT_RERANK).mkdir(parents=True)

    settings_service.update({"rag.rerank_model": "BAAI/bge-reranker-base"})

    assert DEFAULT_RERANK not in _folders(models)
    assert DEFAULT_RERANK not in _folders(models / ".locks")
    assert DEFAULT_EMBED in _folders(models)


def test_the_weights_of_the_models_the_settings_name_stay(models: Path) -> None:
    _fake_weights(models, MPNET_EMBED)
    _fake_weights(models, BGE_RERANK)

    settings_service.update(
        {
            "rag.embed_model": "sentence-transformers/paraphrase-multilingual-mpnet-base-v2",
            "rag.rerank_model": "BAAI/bge-reranker-base",
        }
    )

    assert _folders(models) == {MPNET_EMBED, BGE_RERANK}


def test_clearing_a_model_setting_keeps_the_defaults_weights(models: Path) -> None:
    _fake_weights(models, MPNET_EMBED)
    _fake_weights(models, BGE_RERANK)
    settings_service.update(
        {
            "rag.embed_model": "sentence-transformers/paraphrase-multilingual-mpnet-base-v2",
            "rag.rerank_model": "BAAI/bge-reranker-base",
        }
    )
    _fake_weights(models, DEFAULT_EMBED)
    _fake_weights(models, DEFAULT_RERANK)

    settings_service.update({"rag.embed_model": "", "rag.rerank_model": None})

    assert _folders(models) == {DEFAULT_EMBED, DEFAULT_RERANK}


def test_folders_the_app_does_not_recognise_stay(models: Path) -> None:
    for name in ("my-own-model", "models--someone--private-finetune", "tmp"):
        (models / name).mkdir()

    settings_service.update(
        {
            "rag.embed_model": "sentence-transformers/paraphrase-multilingual-mpnet-base-v2",
            "rag.rerank_model": "BAAI/bge-reranker-base",
        }
    )

    assert {"my-own-model", "models--someone--private-finetune", "tmp"} <= _folders(models)


def test_turning_the_reranker_off_keeps_its_weights(models: Path) -> None:
    """Off is not another model: turning it back on needs no download."""
    settings_service.update({"rag.rerank_model": "disabled"})

    assert DEFAULT_RERANK in _folders(models)


def test_the_embedding_weights_stay_while_a_job_holds_the_index(models: Path) -> None:
    """An ingest embeds every batch with the model it started with;
    removing it underneath would only download it again."""
    with jobs.registry().hold("ingest", index.INDEX, busy=IndexBusy):
        settings_service.update(
            {"rag.embed_model": "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"}
        )

    assert DEFAULT_EMBED in _folders(models)


def test_a_removal_that_did_not_finish_is_finished_on_the_next_switch(
    models: Path,
) -> None:
    _fake_weights(models, BGE_RERANK + ".removing")

    settings_service.update({"rag.rerank_model": "BAAI/bge-reranker-base"})

    assert BGE_RERANK + ".removing" not in _folders(models)


def test_weights_another_model_shares_with_the_current_one_stay(models: Path) -> None:
    """Two variants of one model can download into the same folder."""
    shared = "models--nomic-ai--nomic-embed-text-v1.5"
    _fake_weights(models, shared)
    settings_service.update({"rag.embed_model": "nomic-ai/nomic-embed-text-v1.5"})

    settings_service.update({"rag.embed_model": "nomic-ai/nomic-embed-text-v1.5-Q"})

    assert shared in _folders(models)
