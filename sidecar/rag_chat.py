"""Streaming OpenAI-compatible chat client.

Mirrors labels_llm.call_llm but with stream=true: yields content
deltas as they arrive so /rag/query can re-emit them as SSE events to
the renderer's chat panel.

Why this is separate from labels_llm:
  labels_llm is single-shot JSON classification — it reads the whole
  response, parses, returns. The chat path needs progressive output
  (the user sees tokens land one by one) and a different defaults
  shape (temperature 0.3 vs 0, no max_tokens cap so the model writes
  a full answer, longer timeout to allow for long thinking-style
  responses).

Why urllib not httpx:
  Matches labels_llm's transport choice — one less dep to load in the
  hot path and consistent error surfacing across modules.
"""

from __future__ import annotations

import json
from typing import Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_TEMPERATURE = 0.3
DEFAULT_TIMEOUT = 600.0  # very long: streaming a thinking-model answer can run minutes


class ChatError(RuntimeError):
    """Wraps transport / decode failures so callers (SSE endpoint, tests)
    can surface a structured message without importing urllib themselves.
    """


def stream_chat(
    endpoint: str,
    model: str,
    api_key: str,
    messages: list[dict],
    *,
    temperature: float = DEFAULT_TEMPERATURE,
    timeout: float = DEFAULT_TIMEOUT,
) -> Iterator[str]:
    """Stream content deltas from /v1/chat/completions.

    Yields the string content of each SSE `delta.content` chunk as it
    arrives. Stops on `[DONE]` or an in-stream `error` event. Any
    transport failure is wrapped in ChatError before yielding to the
    caller — the caller decides whether to surface it in-band on the
    SSE side or break the connection.
    """
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = Request(
        f"{endpoint.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
    )
    try:
        resp = urlopen(req, timeout=timeout)
    except HTTPError as exc:
        try:
            err_body = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            err_body = "<unreadable>"
        raise ChatError(f"HTTP {exc.code}: {exc.reason}: {err_body}") from exc
    except URLError as exc:
        raise ChatError(f"connection failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise ChatError(f"connection timed out: {exc}") from exc

    with resp:
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                # Some servers emit empty pings or keep-alive lines —
                # ignore them silently rather than aborting the stream.
                continue
            if isinstance(obj, dict) and "error" in obj:
                err = obj["error"]
                msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                raise ChatError(f"server error in stream: {msg}")
            choices = obj.get("choices") or []
            if not choices:
                continue
            delta = (choices[0].get("delta") or {}).get("content") or ""
            if delta:
                yield delta
