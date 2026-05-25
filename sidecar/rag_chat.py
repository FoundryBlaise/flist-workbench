"""Streaming chat client — OpenAI-compatible OR Ollama-native.

Two code paths under one public entry point (`stream_chat`):

  OpenAI-compatible (default)
      Hits `<endpoint>/chat/completions`, expects SSE deltas with
      `choices[0].delta.content`. Works for LM Studio, OpenAI itself,
      and any other server that mirrors the spec.

  Ollama-native
      Hits `<base>/api/chat`, expects NDJSON with `message.content`
      per line. Used when the endpoint URL contains port 11434 (the
      Ollama default) OR a path component named "api".

Why Ollama needs its own path:
  Ollama's OpenAI-compatible shim only passes a fixed allow-list of
  fields through (model, messages, temperature, top_p, max_tokens,
  seed, stream, stop, tools, response_format). The `options` field —
  where `num_ctx`, `num_predict`, `repeat_penalty`, `keep_alive` etc.
  live — is silently dropped. The native /api/chat endpoint accepts
  them. Without this path our context-window setting was a no-op for
  Ollama users.

Why detection by URL not by user toggle:
  The user just types their endpoint in Settings; making them pick
  "openai vs ollama" alongside is a footgun (the default LM Studio
  preset would still need them to know which kind it is). URL-based
  detection covers the common cases (LM Studio :1234 → openai, Ollama
  :11434 → ollama). A user with an exotic setup can override by
  picking the endpoint kind explicitly via `endpoint_kind=` arg —
  exposed for tests; not surfaced in settings yet.

Why urllib not httpx:
  Matches labels_llm's transport choice — one less dep to load in the
  hot path and consistent error surfacing across modules.
"""

from __future__ import annotations

import json
from typing import Iterator, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

DEFAULT_TEMPERATURE = 0.3
DEFAULT_TIMEOUT = 600.0  # very long: streaming a thinking-model answer can run minutes

EndpointKind = Literal["openai", "ollama", "auto"]


class ChatError(RuntimeError):
    """Wraps transport / decode failures so callers (SSE endpoint, tests)
    can surface a structured message without importing urllib themselves.
    """


def detect_endpoint_kind(endpoint: str) -> Literal["openai", "ollama"]:
    """Return 'ollama' when the URL looks like an Ollama instance, else 'openai'.

    Signals (any one wins):
      - the port is 11434 (Ollama's default)
      - the path contains "/api/" (already targeting Ollama's native API)

    Everything else (LM Studio :1234, openai.com, vLLM, TEI) falls back
    to the OpenAI-compatible path.
    """
    try:
        parsed = urlparse(endpoint)
    except Exception:  # noqa: BLE001 — malformed URLs degrade safely
        return "openai"
    if parsed.port == 11434:
        return "ollama"
    # An endpoint already on a /api path is unmistakably Ollama-native.
    if "/api/" in (parsed.path or "") or (parsed.path or "").endswith("/api"):
        return "ollama"
    return "openai"


def _ollama_base(endpoint: str) -> str:
    """Strip a trailing /v1 (or /v1/) from the endpoint so the Ollama
    native API path can be appended cleanly. Idempotent.
    """
    e = endpoint.rstrip("/")
    if e.endswith("/v1"):
        e = e[: -len("/v1")]
    return e


def stream_chat(
    endpoint: str,
    model: str,
    api_key: str,
    messages: list[dict],
    *,
    temperature: float = DEFAULT_TEMPERATURE,
    timeout: float = DEFAULT_TIMEOUT,
    num_ctx: int | None = None,
    endpoint_kind: EndpointKind = "auto",
) -> Iterator[str]:
    """Stream content deltas from the chat endpoint.

    Yields the string content of each delta as it arrives. Any
    transport failure is wrapped in ChatError before yielding to the
    caller — the caller decides whether to surface it in-band on the
    SSE side or break the connection.

    `num_ctx` (when truthy) is forwarded as `options.num_ctx`. Honoured
    by Ollama (via the native /api/chat path); LM Studio loads its
    context at model selection time and ignores the field in either
    path.

    `endpoint_kind` defaults to auto-detection by URL shape. Override
    explicitly if the heuristic guesses wrong for your setup.
    """
    kind = endpoint_kind if endpoint_kind != "auto" else detect_endpoint_kind(endpoint)
    if kind == "ollama":
        yield from _stream_ollama_native(
            endpoint,
            model,
            api_key,
            messages,
            temperature=temperature,
            timeout=timeout,
            num_ctx=num_ctx,
        )
        return
    yield from _stream_openai_compat(
        endpoint,
        model,
        api_key,
        messages,
        temperature=temperature,
        timeout=timeout,
        num_ctx=num_ctx,
    )


def _stream_openai_compat(
    endpoint: str,
    model: str,
    api_key: str,
    messages: list[dict],
    *,
    temperature: float,
    timeout: float,
    num_ctx: int | None,
) -> Iterator[str]:
    """OpenAI-compatible /v1/chat/completions SSE consumer.

    num_ctx is included even though the OpenAI spec doesn't define
    `options` — some forks (vLLM, TGI extensions) honour it. Servers
    that don't recognise the field will ignore it harmlessly.
    """
    payload: dict = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }
    if num_ctx:
        payload["options"] = {"num_ctx": int(num_ctx)}
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


def _stream_ollama_native(
    endpoint: str,
    model: str,
    api_key: str,
    messages: list[dict],
    *,
    temperature: float,
    timeout: float,
    num_ctx: int | None,
) -> Iterator[str]:
    """Ollama's native /api/chat NDJSON streamer.

    Body shape per https://github.com/ollama/ollama/blob/main/docs/api.md:
        {model, messages, stream, options: {num_ctx, temperature}}
    Response is NDJSON — one JSON object per line, each with
    `message.content`. Terminal object has `done: true`.
    """
    options: dict = {"temperature": temperature}
    if num_ctx:
        options["num_ctx"] = int(num_ctx)
    payload: dict = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": options,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        # Ollama doesn't itself check auth, but a reverse proxy in
        # front of it might (Caddy + bearer auth is a common pattern).
        # Pass the header through so those setups keep working.
        headers["Authorization"] = f"Bearer {api_key}"
    req = Request(
        f"{_ollama_base(endpoint)}/api/chat",
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
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            # In-stream error surface — Ollama puts these as
            # {"error": "..."} on a single line.
            if isinstance(obj, dict) and obj.get("error"):
                raise ChatError(f"server error in stream: {obj['error']}")
            msg = obj.get("message") or {}
            delta = msg.get("content") or ""
            if delta:
                yield delta
            if obj.get("done"):
                break
