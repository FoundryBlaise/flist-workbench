"""Embedding — in-process, through `rag_embed_local`.

There used to be a second path here: an OpenAI-compatible HTTP client
that posted to `<endpoint>/embeddings`, so the model lived in whatever
inference server the user already ran. It worked, but it meant a fresh
install did nothing useful until someone had installed Ollama or LM
Studio, pulled a model and pasted a URL into a settings dialog. For a
tool whose whole premise is "attach an MCP client and ask", that was the
wrong first five minutes.

MCP cannot take the job either — the protocol has `sampling/createMessage`
for asking the connected client for a completion, but nothing that
returns vectors. So embedding runs here, in ONNX through fastembed, the
same way reranking already did, and the endpoint path is gone.

This module stays as the seam: `embed_texts` and `probe` are what the
ingest job, the query path and the connection test call, and none of
them knows where the vectors come from.
"""

from __future__ import annotations

from typing import Literal

import rag_embed_local
from rag import RagSettings

#: fastembed batches underneath this; the number only bounds how much we
#: hand it at once.
DEFAULT_BATCH = rag_embed_local.DEFAULT_BATCH
#: Tiny canned probe used by the connection test. Short so even a cold
#: model answers quickly.
PROBE_TEXT = "hello"

EmbedKind = Literal["query", "document"]


class EmbedError(RuntimeError):
    """Model load or ONNX execution failed.

    Kept as its own type rather than letting LocalEmbedError through:
    every caller already catches this one, and a second backend would
    raise the same thing.
    """


def embed_texts(
    texts: list[str],
    kind: EmbedKind,
    settings: RagSettings,
    *,
    batch: int = DEFAULT_BATCH,
) -> list[list[float]]:
    """Embed a list of strings, returning one vector per input.

    Empty input gives empty output. Model-specific prefixes are applied
    by `rag_embed_local` from its own table — fastembed does not add
    them, measured, and getting them wrong costs recall with no error to
    show for it.
    """
    if not texts:
        return []
    try:
        return rag_embed_local.embed(texts, kind, settings.embed_model, batch=batch)
    except rag_embed_local.LocalEmbedError as exc:
        raise EmbedError(str(exc)) from exc


def probe(settings: RagSettings, *, timeout: float = 30.0) -> tuple[int, list[float]]:
    """Embed one canned string; return (dimension, vector).

    Callers use the dimension to size the Qdrant collection and to spot
    a model swap. `timeout` is accepted and ignored — it meant something
    when this was an HTTP call; the local path either loads the model or
    raises.
    """
    vecs = embed_texts([PROBE_TEXT], "document", settings)
    if not vecs:
        raise EmbedError("probe returned no vectors")
    return len(vecs[0]), vecs[0]
