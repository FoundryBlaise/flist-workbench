"""Assistant chat orchestrator.

One non-streaming round-trip to the LLM per "thinking step" — the
model gets the full tool catalog, may emit zero or more tool calls,
sidecar dispatches them in-process, appends the results back into
the message history, and asks the model again. Loops until the
model produces a final text response (no tool_calls) or the per-turn
round cap is hit.

Why non-streaming the tool loop
-------------------------------
OpenAI / LM Studio / Ollama all expose function-calling in their
chat APIs, but the streaming protocols for partial tool_calls
differ enough that hand-rolling a shared parser is brittle. Tool
dispatch is local + cheap (read tools hit disk, composite tools do
small in-memory diffs, persistence is one SQLite-equivalent write),
so the user-perceived latency of waiting for the LLM to finish each
round is dominated by model time, not transport. A future PR can
swap the final text round to streaming once we're confident the
tool surface is stable.

Renderer-facing SSE event stream
--------------------------------
The HTTP endpoint emits Server-Sent Events with these `event:` types:

- `start`   {turn_id, model_id, model_endpoint}
- `text`    {content, round}      — model text reply (always last round)
- `tool_call` {round, tool, args, call_id}
- `tool_result` {round, call_id, ok, result?, error?}
- `draft_update` {draft}          — emitted after any successful
                                    `append_edits` so the renderer
                                    can refresh the review pane
- `error`   {message, code}       — non-recoverable failure
- `done`    {turn_id}

The renderer reconstructs the transcript from this stream; sidecar
does not persist any chat history.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import ai_draft
import ai_tools_atomic
import ai_tools_composite
import ai_tools_read
import character_archive
import rag_chat
import settings as settings_store


LOG = logging.getLogger("assistant_chat")

PROMPTS_DIR = Path(__file__).parent / "prompts"
DEFAULT_PROMPT_NSFW = (PROMPTS_DIR / "assistant_v1_nsfw_aware.txt").read_text(
    encoding="utf-8"
)
DEFAULT_PROMPT_SFW = (PROMPTS_DIR / "assistant_v1_sfw.txt").read_text(encoding="utf-8")

MAX_TOOL_ROUNDS = 5  # safety: never loop on a model that won't stop calling tools


# ---- resolved-settings helper ---------------------------------------


@dataclass(frozen=True)
class AssistantConfig:
    endpoint: str
    model: str
    api_key: str
    system_prompt: str
    temperature: float
    timeout_sec: float
    token_budget: int


def resolve_assistant_config(conn) -> AssistantConfig:
    """Build the runtime config from the settings store. Falls back
    to the RAG chat endpoint when the assistant-specific endpoint is
    unset — most users want one LM Studio instance powering both.
    The prompt preset string (`nsfw`/`sfw`/`custom`) picks the
    shipped default; a custom `system_prompt` value overrides both.
    """
    endpoint = (
        settings_store.get(conn, settings_store.KEY_AI_ASSISTANT_ENDPOINT) or ""
    ).strip()
    if not endpoint:
        endpoint = (
            settings_store.get(conn, settings_store.KEY_RAG_CHAT_ENDPOINT) or ""
        ).strip()
    if not endpoint:
        endpoint = (
            settings_store.get(conn, settings_store.KEY_LABELS_LLM_ENDPOINT) or ""
        ).strip()

    model = (
        settings_store.get(conn, settings_store.KEY_AI_ASSISTANT_MODEL) or ""
    ).strip()
    if not model:
        model = (
            settings_store.get(conn, settings_store.KEY_RAG_CHAT_MODEL) or ""
        ).strip()
    if not model:
        model = (
            settings_store.get(conn, settings_store.KEY_LABELS_LLM_MODEL) or ""
        ).strip()

    api_key = (
        settings_store.get(conn, settings_store.KEY_AI_ASSISTANT_API_KEY) or ""
    ).strip()
    if not api_key:
        api_key = (
            settings_store.get(conn, settings_store.KEY_RAG_CHAT_API_KEY) or ""
        ).strip()

    preset = (
        settings_store.get(conn, settings_store.KEY_AI_ASSISTANT_PROMPT_PRESET)
        or "nsfw"
    ).strip().lower()
    # Only the explicit 'custom' preset reads the user-authored prompt;
    # otherwise the preset wins. Previously a once-saved custom prompt
    # silently overrode every preset switch in Settings, which was
    # confusing — the dropdown looked broken.
    if preset == "custom":
        custom = settings_store.get(
            conn, settings_store.KEY_AI_ASSISTANT_SYSTEM_PROMPT
        )
        system_prompt = (
            custom if isinstance(custom, str) and custom.strip() else DEFAULT_PROMPT_NSFW
        )
    elif preset == "sfw":
        system_prompt = DEFAULT_PROMPT_SFW
    else:
        system_prompt = DEFAULT_PROMPT_NSFW

    temperature = _parse_float(
        settings_store.get(conn, settings_store.KEY_AI_ASSISTANT_TEMPERATURE),
        default=0.3,
    )
    timeout_sec = _parse_float(
        settings_store.get(conn, settings_store.KEY_AI_ASSISTANT_TIMEOUT_SEC),
        default=120.0,
    )
    token_budget = int(
        _parse_float(
            settings_store.get(conn, settings_store.KEY_AI_ASSISTANT_TOKEN_BUDGET),
            default=12000.0,
        )
    )

    return AssistantConfig(
        endpoint=endpoint,
        model=model,
        api_key=api_key,
        system_prompt=system_prompt,
        temperature=temperature,
        timeout_sec=timeout_sec,
        token_budget=token_budget,
    )


def _parse_float(value: str | None, *, default: float) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# ---- tool catalogue + dispatch --------------------------------------


def all_tool_schemas() -> list[dict[str, Any]]:
    """Combined function-tool list for the chat API. The atomic write
    tools, the read tools, and the composite write tools all live in
    one flat namespace as far as the model is concerned."""
    return [
        {"type": "function", "function": s}
        for s in (
            ai_tools_atomic.ATOMIC_TOOL_SCHEMAS
            + ai_tools_read.READ_TOOL_SCHEMAS
            + ai_tools_composite.COMPOSITE_TOOL_SCHEMAS
        )
    ]


def _is_read_tool(name: str) -> bool:
    return name in ai_tools_read.read_tool_names()


def _is_composite_tool(name: str) -> bool:
    return name in ai_tools_composite.composite_tool_names()


def _is_atomic_tool(name: str) -> bool:
    return name in ai_tools_atomic.atomic_tool_names()


@dataclass
class ToolDispatchResult:
    ok: bool
    payload: Any = None
    error: str = ""
    # When a tool dispatched edits, the new draft state — surfaced to
    # the renderer via `draft_update` so the review pane refreshes
    # without polling.
    draft: dict[str, Any] | None = None


def dispatch_tool(
    tool_name: str,
    args: dict[str, Any],
    *,
    active_character_id: str | None,
    mapping_list: dict[str, Any],
    model_endpoint: str,
    model_id: str,
) -> ToolDispatchResult:
    """Single entry point for every tool the model can call. Returns a
    result envelope tailored to its kind:

    - Read tools: `payload` is the data the read returned.
    - Atomic/composite writes: `payload` is `{accepted_edit_ids,
      rejected, draft}` from `ai_draft.append_edits`; `draft` echoes
      the updated draft so the SSE layer can fan out a `draft_update`.

    Errors are converted to `ok=False` with a human-readable `error`
    so the chat loop can hand them back to the model as a tool
    response without exception bookkeeping.
    """
    try:
        if _is_read_tool(tool_name):
            data = ai_tools_read.execute_read_tool(
                tool_name,
                args,
                active_character_id=active_character_id,
                mapping_list=mapping_list,
            )
            return ToolDispatchResult(ok=True, payload=data)

        if _is_atomic_tool(tool_name):
            if not active_character_id:
                return ToolDispatchResult(ok=False, error="no_active_character")
            raw_edit = ai_tools_atomic.build_edit_from_tool_call(tool_name, args)
            result = ai_draft.append_edits(
                active_character_id,
                [raw_edit],
                mapping_list,
                model_endpoint=model_endpoint,
                model_id=model_id,
            )
            return ToolDispatchResult(
                ok=True,
                payload={
                    "accepted_edit_ids": result["accepted_edit_ids"],
                    "rejected": result["rejected"],
                },
                draft=result["draft"],
            )

        if _is_composite_tool(tool_name):
            if not active_character_id:
                return ToolDispatchResult(ok=False, error="no_active_character")
            edits = ai_tools_composite.execute_composite_tool(
                tool_name,
                args,
                active_character_id=active_character_id,
            )
            if not edits:
                return ToolDispatchResult(
                    ok=True,
                    payload={"accepted_edit_ids": [], "rejected": [], "no_changes": True},
                )
            result = ai_draft.append_edits(
                active_character_id,
                edits,
                mapping_list,
                model_endpoint=model_endpoint,
                model_id=model_id,
            )
            return ToolDispatchResult(
                ok=True,
                payload={
                    "accepted_edit_ids": result["accepted_edit_ids"],
                    "rejected": result["rejected"],
                },
                draft=result["draft"],
            )

        return ToolDispatchResult(ok=False, error=f"unknown_tool:{tool_name}")

    except LookupError as exc:
        return ToolDispatchResult(ok=False, error=str(exc))
    except ValueError as exc:
        return ToolDispatchResult(ok=False, error=str(exc))
    except Exception as exc:  # noqa: BLE001 — log + surface, don't crash the stream
        LOG.exception("tool dispatch failed: %s", tool_name)
        return ToolDispatchResult(ok=False, error=f"internal_error: {exc!s}")


# ---- LLM round-trip --------------------------------------------------


class ChatTransportError(RuntimeError):
    """Wraps network / decode failures so the SSE layer can surface
    them as `error` events without leaking transport stack frames to
    the renderer."""


def call_llm_round(
    config: AssistantConfig,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """One non-streaming /chat/completions request. Returns the raw
    `choices[0].message` dict so the caller can inspect `content` +
    `tool_calls`.

    Same auto-detection as rag_chat for OpenAI-compat vs Ollama-native.
    Tool-call response shape is the OpenAI standard
    (`message.tool_calls = [{id, type:function, function:{name, arguments}}]`);
    Ollama's native /api/chat mirrors this exactly when `tools=[...]`
    is supplied.
    """
    if not config.endpoint:
        raise ChatTransportError(
            "no_endpoint: configure the AI Assistant endpoint in Settings first"
        )
    if not config.model:
        raise ChatTransportError(
            "no_model: configure the AI Assistant model in Settings first"
        )

    kind = rag_chat.detect_endpoint_kind(config.endpoint)
    if kind == "ollama":
        return _call_ollama(config, messages, tools=tools)
    return _call_openai_compat(config, messages, tools=tools)


def _call_openai_compat(
    config: AssistantConfig,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": config.model,
        "messages": messages,
        "temperature": config.temperature,
        "stream": False,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    headers = {"Content-Type": "application/json"}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"
    url = config.endpoint.rstrip("/") + "/chat/completions"
    req = Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers)
    try:
        with urlopen(req, timeout=config.timeout_sec) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        try:
            body = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            body = "<unreadable>"
        raise ChatTransportError(f"HTTP {exc.code}: {exc.reason}: {body}") from exc
    except URLError as exc:
        raise ChatTransportError(f"connection failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise ChatTransportError(f"timeout: {exc}") from exc
    except OSError as exc:
        # Catch-all for socket-level failures urlopen doesn't wrap in
        # URLError: ConnectionResetError mid-read, gaierror, SSL
        # errors, broken-pipe. Without this the exception leaks out of
        # the SSE generator and the renderer sees a stream that just
        # stops with no `error` event.
        raise ChatTransportError(f"network error: {exc!r}") from exc

    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise ChatTransportError(f"non-JSON response: {raw[:200]}") from exc
    choices = body.get("choices") or []
    if not choices:
        raise ChatTransportError(f"no choices in response: {raw[:200]}")
    return choices[0].get("message") or {}


def _call_ollama(
    config: AssistantConfig,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    options: dict[str, Any] = {"temperature": config.temperature}
    payload: dict[str, Any] = {
        "model": config.model,
        "messages": messages,
        "stream": False,
        "options": options,
    }
    if tools:
        payload["tools"] = tools
    headers = {"Content-Type": "application/json"}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"
    url = rag_chat._ollama_base(config.endpoint) + "/api/chat"
    req = Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers)
    try:
        with urlopen(req, timeout=config.timeout_sec) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        try:
            body = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            body = "<unreadable>"
        raise ChatTransportError(f"HTTP {exc.code}: {exc.reason}: {body}") from exc
    except URLError as exc:
        raise ChatTransportError(f"connection failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise ChatTransportError(f"timeout: {exc}") from exc
    except OSError as exc:
        # Catch-all for socket-level failures urlopen doesn't wrap in
        # URLError: ConnectionResetError mid-read, gaierror, SSL
        # errors, broken-pipe. Without this the exception leaks out of
        # the SSE generator and the renderer sees a stream that just
        # stops with no `error` event.
        raise ChatTransportError(f"network error: {exc!r}") from exc

    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise ChatTransportError(f"non-JSON response: {raw[:200]}") from exc
    return body.get("message") or {}


# ---- orchestration ---------------------------------------------------


def build_initial_messages(
    system_prompt: str,
    history: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Prepend the system prompt to whatever transcript the renderer
    sends. The renderer can omit the system message (we always inject
    the resolved one) but a leading system entry from the client is
    accepted and overridden — it would otherwise stick around in
    multi-turn conversations and confuse drift checks."""
    cleaned = [m for m in history if m.get("role") != "system"]
    return [{"role": "system", "content": system_prompt}, *cleaned]


def _parse_tool_arguments(call: dict[str, Any]) -> dict[str, Any]:
    """OpenAI streams tool args as a JSON-encoded string under
    `function.arguments`; Ollama sometimes ships a dict directly. Tolerate
    both, plus the occasional empty string."""
    fn = call.get("function") or {}
    raw = fn.get("arguments")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        raw_s = raw.strip()
        if not raw_s:
            return {}
        try:
            parsed = json.loads(raw_s)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def run_chat_turn(
    config: AssistantConfig,
    history: list[dict[str, Any]],
    *,
    active_character_id: str | None,
    mapping_list: dict[str, Any],
) -> Iterator[dict[str, Any]]:
    """Drive one user turn through (up to) MAX_TOOL_ROUNDS LLM rounds.
    Yields renderer-facing event dicts.

    The history list is mutated in place — caller can capture the
    final list for any post-turn debugging.
    """
    yield {
        "event": "start",
        "data": {
            "model_id": config.model,
            "model_endpoint": config.endpoint,
        },
    }

    messages = build_initial_messages(config.system_prompt, history)
    tools = all_tool_schemas()

    for round_n in range(MAX_TOOL_ROUNDS):
        try:
            msg = call_llm_round(config, messages, tools=tools)
        except ChatTransportError as exc:
            yield {
                "event": "error",
                "data": {"code": "transport", "message": str(exc)},
            }
            yield {"event": "done", "data": {}}
            return

        messages.append({k: v for k, v in msg.items() if k in {"role", "content", "tool_calls"}})

        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            content = msg.get("content") or ""
            if content:
                yield {"event": "text", "data": {"content": content, "round": round_n}}
            yield {"event": "done", "data": {}}
            return

        for call in tool_calls:
            fn = call.get("function") or {}
            name = fn.get("name") or ""
            args = _parse_tool_arguments(call)
            call_id = call.get("id") or f"call-{round_n}-{name}"
            yield {
                "event": "tool_call",
                "data": {
                    "round": round_n,
                    "tool": name,
                    "args": args,
                    "call_id": call_id,
                },
            }
            outcome = dispatch_tool(
                name,
                args,
                active_character_id=active_character_id,
                mapping_list=mapping_list,
                model_endpoint=config.endpoint,
                model_id=config.model,
            )
            result_payload = (
                {"ok": True, "result": outcome.payload}
                if outcome.ok
                else {"ok": False, "error": outcome.error}
            )
            yield {
                "event": "tool_result",
                "data": {
                    "round": round_n,
                    "call_id": call_id,
                    **result_payload,
                },
            }
            if outcome.draft is not None:
                yield {
                    "event": "draft_update",
                    "data": {"draft": outcome.draft},
                }
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": name,
                    "content": json.dumps(result_payload),
                }
            )

    # Round cap reached — model kept calling tools instead of
    # answering. Surface as an error rather than a silent truncation.
    yield {
        "event": "error",
        "data": {
            "code": "tool_loop_cap",
            "message": (
                f"model kept calling tools for {MAX_TOOL_ROUNDS} rounds without "
                f"producing a text reply; aborted to prevent runaway."
            ),
        },
    }
    yield {"event": "done", "data": {}}


# ---- SSE helpers -----------------------------------------------------


def sse_format(event: dict[str, Any]) -> bytes:
    """Render `{event, data}` into the canonical `event:`+`data:` SSE
    frame. Always one event per frame; never partial.

    The trailing blank line is mandatory; `urllib`/`httpx` SSE
    consumers buffer until they see it."""
    name = event.get("event", "message")
    data = json.dumps(event.get("data") or {})
    return f"event: {name}\ndata: {data}\n\n".encode("utf-8")
