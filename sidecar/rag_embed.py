"""OpenAI-compatible embedding client.

Talks to `<endpoint>/embeddings` (LM Studio, OpenAI, Ollama-via-openai,
TEI, vLLM all expose this shape). No torch, no onnx, no sentence-
transformers — the model lives in whatever inference server the user
already runs for chat. One process, one config, one set of GPU.

Two callable entry points:

  embed_texts(texts, kind, settings)  — batched embedding for ingest /
    query. `kind` selects the per-side prefix from settings (nomic
    quirk; empty for everything else).

  probe(settings)                     — one-shot embedding of a tiny
    canned string. Returns (dimension, vector) on success so the UI
    can validate the endpoint + model and record the dim before any
    real ingest creates the Qdrant collection.

Both raise `EmbedError` on transport / decode failures so callers can
surface a structured message; the test-connection endpoint catches it
and returns ok=false rather than HTTP 500.
"""

from __future__ import annotations

import json
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from rag import RagSettings

# Bigger than the labels batch (which is one-message-at-a-time) — an
# embedding call is one round-trip per batch and most servers handle 16
# inputs per request comfortably. Lower if a user reports OOM on tiny
# models, but 16 is conservative for a 768-dim model.
DEFAULT_BATCH = 16
DEFAULT_TIMEOUT = 120.0
# Tiny canned probe used by /rag/test-embedding. Keep it short so even
# a misconfigured large model can return within the timeout.
PROBE_TEXT = "hello"

EmbedKind = Literal["query", "document"]


class EmbedError(RuntimeError):
    """Wraps transport / decode failures so callers don't import urllib themselves."""


def _prefix_for(kind: EmbedKind, settings: RagSettings) -> str:
    if kind == "query":
        return settings.embed_query_prefix
    return settings.embed_document_prefix


def _post(
    endpoint: str,
    api_key: str,
    body: dict,
    *,
    timeout: float,
) -> dict:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = Request(
        f"{endpoint.rstrip('/')}/embeddings",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except HTTPError as exc:
        try:
            err_body = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            err_body = "<unreadable>"
        raise EmbedError(f"HTTP {exc.code}: {exc.reason}: {err_body}") from exc
    except URLError as exc:
        raise EmbedError(f"connection failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise EmbedError(f"timed out after {int(timeout)} s: {exc}") from exc


def _extract_vectors(body: dict) -> list[list[float]]:
    data = body.get("data")
    if not isinstance(data, list) or not data:
        raise EmbedError(f"response missing 'data' array: {str(body)[:200]}")
    # OpenAI guarantees data[i].embedding lines up with input[i] only
    # when the server respects the input order. The spec says it does;
    # all real servers we target do. If a future server returns out-of-
    # order results we'd need to sort by data[i].index — flag here so
    # the bug is obvious instead of silently swapping vectors.
    out: list[list[float]] = []
    for item in data:
        vec = item.get("embedding")
        if not isinstance(vec, list) or not vec:
            raise EmbedError("response item missing 'embedding'")
        out.append([float(x) for x in vec])
    return out


def embed_texts(
    texts: list[str],
    kind: EmbedKind,
    settings: RagSettings,
    *,
    batch: int = DEFAULT_BATCH,
    timeout: float = DEFAULT_TIMEOUT,
    keep_alive: str | int | None = None,
) -> list[list[float]]:
    """Embed a list of strings, returning one vector per input.

    `keep_alive` is forwarded to the server as a per-request override
    (Ollama-specific; unknown fields are ignored by LM Studio / OpenAI /
    vLLM / TEI). Use a short value like "30s" or 0 to make the embed
    model drop quickly on VRAM-tight setups — see chat_embed_keep_alive
    in rag.RagSettings. None means "don't send the field"; Ollama then
    uses its own default (~5 minutes).

    Empty input → empty output (the server might reject a zero-length
    list outright; cheaper to short-circuit).
    """
    if not texts:
        return []
    prefix = _prefix_for(kind, settings)
    out: list[list[float]] = []
    for i in range(0, len(texts), batch):
        chunk = texts[i : i + batch]
        prefixed = [prefix + t for t in chunk] if prefix else chunk
        body: dict = {"model": settings.embed_model, "input": prefixed}
        if keep_alive is not None:
            body["keep_alive"] = keep_alive
        resp = _post(
            settings.embed_endpoint,
            settings.embed_api_key,
            body,
            timeout=timeout,
        )
        vectors = _extract_vectors(resp)
        if len(vectors) != len(chunk):
            raise EmbedError(
                f"requested {len(chunk)} embeddings, got {len(vectors)} back"
            )
        out.extend(vectors)
    return out


def probe(settings: RagSettings, *, timeout: float = 30.0) -> tuple[int, list[float]]:
    """One-shot embedding of PROBE_TEXT.

    Returns (dimension, vector). Callers (the test-connection endpoint
    and the ingest job's first request) use the dimension to decide
    Qdrant collection sizing and to detect mid-life model swaps.
    """
    vecs = embed_texts([PROBE_TEXT], "document", settings, timeout=timeout)
    if not vecs:
        raise EmbedError("probe returned no vectors")
    vec = vecs[0]
    return len(vec), vec


def try_unload(settings: RagSettings, *, timeout: float = 10.0) -> bool:
    """Best-effort request to unload the embedding model from VRAM.

    Why this exists: an ingest job pegs the user's GPU for the duration
    of the run, then by default Ollama keeps the model resident for 5
    minutes after the last request — wasted VRAM if the user wanted to
    chat or game right after. Sending `keep_alive: 0` flips that to
    "unload immediately".

    Routing:
      - Ollama (detected by URL shape): POST native /api/generate with
        an empty prompt and keep_alive=0. Ollama treats this as an
        unload-only signal and does NOT re-load the model if it wasn't
        already resident — the OpenAI-compat /v1/embeddings path used
        to re-load it momentarily, which defeated the point.
      - Anything else (LM Studio, vLLM, TEI, OpenAI): the OpenAI-compat
        path with keep_alive=0. LM Studio loads via its own UI so the
        request is a no-op there; cheaper than skipping outright
        because it keeps the code path uniform for non-Ollama servers
        that may also honour keep_alive.

    Returns True on a 2xx response, False on any failure. Caller must
    treat this as advisory only — never raises.
    """
    # Import locally to avoid a cycle (rag_chat imports rag_store, which
    # in some test contexts imports rag_embed for probe).
    from rag_chat import _ollama_base, detect_endpoint_kind  # noqa: PLC0415

    headers = {"Content-Type": "application/json"}
    if settings.embed_api_key:
        headers["Authorization"] = f"Bearer {settings.embed_api_key}"

    kind = detect_endpoint_kind(settings.embed_endpoint)
    if kind == "ollama":
        # Native /api/generate with empty prompt + keep_alive=0 is the
        # documented "unload only" recipe — see
        # https://github.com/ollama/ollama/blob/main/docs/api.md#unload-a-model
        url = f"{_ollama_base(settings.embed_endpoint)}/api/generate"
        body: dict = {
            "model": settings.embed_model,
            "prompt": "",
            "keep_alive": 0,
        }
    else:
        url = f"{settings.embed_endpoint.rstrip('/')}/embeddings"
        body = {
            "model": settings.embed_model,
            "input": [""],
            "keep_alive": 0,
        }
    req = Request(url, data=json.dumps(body).encode("utf-8"), headers=headers)
    try:
        with urlopen(req, timeout=timeout) as resp:
            return 200 <= resp.status < 300
    except Exception:  # noqa: BLE001 — unload is best-effort
        return False
