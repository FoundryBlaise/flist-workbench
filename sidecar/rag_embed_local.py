"""In-process embedding through fastembed / onnxruntime.

The point of this module is that the user installs nothing. Attaching an
MCP client and calling `ingest_logs` has to work on a fresh machine, and
that rules out "first configure an embedding server". So embedding moves
into the sidecar, the same way reranking already lives in `rag_rerank` —
same library, same ONNX runtime, same on-disk model cache, no torch and
no CUDA.

Trade-off, stated plainly: this puts a second model inside a process
that was designed to run none. What it buys is that `rag.embed_backend`
defaults to "local" and the whole embedding configuration disappears
from the app. The endpoint backend stays in `rag_embed` for anyone who
would rather spend a GPU on it and wants a long-context model.

Two things measured rather than assumed, both of which bite silently:

  Prefixes are NOT applied by fastembed. `query_embed`, `passage_embed`
  and `embed` return bit-identical vectors, so the e5 family's mandatory
  "query: " / "passage: " never appear unless we add them. Hence
  MODEL_PROFILES rather than a call to the fastembed helper.

  Context limits are short and truncation is silent. Embedding two texts
  that share a long head and differ only in the tail yields identical
  vectors — the tail is simply dropped, with no error and no warning.
  MiniLM stops around 128 tokens, e5-large around 512, while the chunker
  defaults to 3000 characters. `max_chars` below is what `rag` clamps
  chunking to so the whole chunk actually reaches the model.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

from rag_rerank import models_dir


@dataclass(frozen=True)
class ModelProfile:
    """What a local embedding model needs and what it can take."""

    #: Characters per chunk that still fit the model's token window,
    #: with room for multi-byte German and the odd BBCode tag. Deliberately
    #: conservative: overshooting costs the tail of every chunk silently.
    max_chars: int
    query_prefix: str = ""
    document_prefix: str = ""


#: Multilingual, 384-dim, ~220 MB, apache-2.0. Chosen over the larger
#: `intfloat/multilingual-e5-large` on measurements, not size: on a
#: German question against an English passage plus a German distractor,
#: e5 ranked the distractor higher (0.7903 vs 0.7613) both with and
#: without its prefixes, while this model got it right by a factor of
#: ten (0.2908 vs 0.0298). It is also ~40x faster on CPU. The paraphrase
#: models are trained on parallel data across languages, which is what
#: keeps a mixed German/English corpus from clustering by language.
#:
#: `jinaai/jina-embeddings-v2-base-de` would have been the better fit on
#: paper — bilingual DE/EN, 8192 tokens — but its ONNX export fails to
#: load on current onnxruntime (SimplifiedLayerNormFusion). Worth
#: retrying when onnxruntime or the export is updated.
DEFAULT_LOCAL_EMBED_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

MODEL_PROFILES: dict[str, ModelProfile] = {
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2": ModelProfile(
        max_chars=450
    ),
    "sentence-transformers/paraphrase-multilingual-mpnet-base-v2": ModelProfile(
        max_chars=450
    ),
    "intfloat/multilingual-e5-large": ModelProfile(
        max_chars=1500, query_prefix="query: ", document_prefix="passage: "
    ),
    "jinaai/jina-embeddings-v2-base-en": ModelProfile(max_chars=8000),
    "jinaai/jina-embeddings-v2-small-en": ModelProfile(max_chars=8000),
    "jinaai/jina-embeddings-v2-base-de": ModelProfile(max_chars=8000),
}

#: Applied to models we have not profiled. 450 characters is short
#: enough for every model in fastembed's catalogue, so an unknown id
#: loses recall at worst — never the tail of its own text.
FALLBACK_PROFILE = ModelProfile(max_chars=450)

#: fastembed batches internally; this is what we hand it per call.
DEFAULT_BATCH = 32

_LOCK = threading.Lock()


def profile_for(model_name: str) -> ModelProfile:
    return MODEL_PROFILES.get(model_name, FALLBACK_PROFILE)


@dataclass(slots=True)
class _CachedEmbedder:
    model_name: str
    embedder: object  # fastembed.TextEmbedding


_CACHED: _CachedEmbedder | None = None


class LocalEmbedError(RuntimeError):
    """Model download or ONNX execution failed."""


def _build_embedder(model_name: str, cache_dir: Path):
    # Imported lazily for the same reason as rag_rerank._build_encoder:
    # importing fastembed pulls in onnxruntime and its registries, and
    # the test suite monkeypatches this function to avoid both.
    from fastembed import TextEmbedding

    return TextEmbedding(model_name=model_name, cache_dir=str(cache_dir))


def get_embedder(model_name: str, *, cache_dir: Path | None = None):
    """Return a cached TextEmbedding, building it on first use.

    Construction deserialises the ONNX graph and, the very first time,
    downloads the model — seconds to a minute depending on the line.
    Callers that care about the wait (the ingest job) should warm this
    up before reporting progress, or the first batch looks hung.
    """
    global _CACHED
    with _LOCK:
        if _CACHED is not None and _CACHED.model_name == model_name:
            return _CACHED.embedder
        cache = cache_dir or models_dir()
        try:
            embedder = _build_embedder(model_name, cache)
        except Exception as exc:  # noqa: BLE001 — surfaces as a tool error
            raise LocalEmbedError(
                f"could not load embedding model {model_name!r}: {exc}"
            ) from exc
        _CACHED = _CachedEmbedder(model_name=model_name, embedder=embedder)
        return embedder


def reset_cache() -> None:
    """Drop the cached embedder — used by tests and after a model swap."""
    global _CACHED
    with _LOCK:
        _CACHED = None


def embed(
    texts: list[str],
    kind: str,
    model_name: str,
    *,
    batch: int = DEFAULT_BATCH,
    cache_dir: Path | None = None,
) -> list[list[float]]:
    """Embed texts locally. `kind` is "query" or "document"."""
    if not texts:
        return []
    prof = profile_for(model_name)
    prefix = prof.query_prefix if kind == "query" else prof.document_prefix
    prepared = [prefix + t for t in texts] if prefix else texts
    embedder = get_embedder(model_name, cache_dir=cache_dir)
    try:
        vectors = [
            list(map(float, v)) for v in embedder.embed(prepared, batch_size=batch)
        ]
    except Exception as exc:  # noqa: BLE001
        raise LocalEmbedError(f"embedding failed: {exc}") from exc
    if len(vectors) != len(texts):
        raise LocalEmbedError(
            f"requested {len(texts)} embeddings, got {len(vectors)} back"
        )
    return vectors


def available_models() -> list[dict]:
    """Model id, dimension, size and licence for the picker.

    Licence is worth surfacing: fastembed's catalogue mixes apache-2.0
    and MIT with cc-by-nc-4.0, and an NC model is a poor default for
    something other people install.
    """
    from fastembed import TextEmbedding

    return [
        {
            "model": m["model"],
            "dimension": m["dim"],
            "size_gb": m.get("size_in_GB"),
            "license": m.get("license"),
            "max_chars": profile_for(m["model"]).max_chars,
        }
        for m in TextEmbedding.list_supported_models()
    ]
