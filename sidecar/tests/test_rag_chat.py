"""rag_chat tests — mock urlopen with a fake SSE stream."""

from __future__ import annotations

import io
import json
from typing import Any

import pytest

import rag_chat


class _FakeStreamResp:
    """Yields a list of bytes lines, mimicking a chunked SSE response."""

    def __init__(self, lines: list[bytes]) -> None:
        self._lines = lines

    def __enter__(self) -> "_FakeStreamResp":
        return self

    def __exit__(self, *_: Any) -> None:
        pass

    def __iter__(self):
        return iter(self._lines)


def _sse(*messages: str) -> list[bytes]:
    return [m.encode("utf-8") + b"\n" for m in messages]


def _delta(content: str) -> str:
    return "data: " + json.dumps(
        {"choices": [{"delta": {"content": content}}]}
    )


def test_stream_chat_yields_each_delta(monkeypatch: pytest.MonkeyPatch) -> None:
    lines = _sse(
        _delta("Hello"),
        _delta(" world"),
        "data: [DONE]",
    )
    monkeypatch.setattr(rag_chat, "urlopen", lambda req, timeout: _FakeStreamResp(lines))
    out = list(
        rag_chat.stream_chat(
            "http://test/v1",
            "gpt-test",
            "",
            [{"role": "user", "content": "hi"}],
        )
    )
    assert out == ["Hello", " world"]


def test_stream_chat_ignores_blank_and_unparseable_lines(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lines = _sse(
        "",
        ": keep-alive comment",
        _delta("hi"),
        "data: not-json",
        "data: [DONE]",
    )
    monkeypatch.setattr(rag_chat, "urlopen", lambda req, timeout: _FakeStreamResp(lines))
    out = list(
        rag_chat.stream_chat(
            "http://test/v1", "m", "", [{"role": "user", "content": "x"}]
        )
    )
    assert out == ["hi"]


def test_stream_chat_skips_empty_delta_content(monkeypatch: pytest.MonkeyPatch) -> None:
    # Some servers emit an empty initial delta (just `role: assistant`).
    role_chunk = "data: " + json.dumps(
        {"choices": [{"delta": {"role": "assistant"}}]}
    )
    lines = _sse(role_chunk, _delta("text"), "data: [DONE]")
    monkeypatch.setattr(rag_chat, "urlopen", lambda req, timeout: _FakeStreamResp(lines))
    assert list(
        rag_chat.stream_chat("http://test/v1", "m", "", [{"role": "user", "content": "x"}])
    ) == ["text"]


def test_stream_chat_raises_chat_error_on_url_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from urllib.error import URLError

    def boom(req, timeout):  # noqa: ARG001
        raise URLError("Connection refused")

    monkeypatch.setattr(rag_chat, "urlopen", boom)
    with pytest.raises(rag_chat.ChatError, match="Connection refused"):
        list(
            rag_chat.stream_chat(
                "http://test/v1", "m", "", [{"role": "user", "content": "x"}]
            )
        )


def test_stream_chat_raises_chat_error_on_http_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from urllib.error import HTTPError

    def boom(req, timeout):  # noqa: ARG001
        raise HTTPError(
            req.full_url,
            500,
            "Internal Server Error",
            {},
            io.BytesIO(b'{"error":"bad"}'),
        )

    monkeypatch.setattr(rag_chat, "urlopen", boom)
    with pytest.raises(rag_chat.ChatError, match="500"):
        list(
            rag_chat.stream_chat(
                "http://test/v1", "m", "", [{"role": "user", "content": "x"}]
            )
        )


def test_stream_chat_raises_chat_error_on_in_stream_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    err_chunk = "data: " + json.dumps({"error": {"message": "context overflow"}})
    lines = _sse(_delta("partial "), err_chunk, "data: [DONE]")
    monkeypatch.setattr(rag_chat, "urlopen", lambda req, timeout: _FakeStreamResp(lines))
    gen = rag_chat.stream_chat(
        "http://test/v1", "m", "", [{"role": "user", "content": "x"}]
    )
    # First delta lands, then the error chunk raises.
    assert next(gen) == "partial "
    with pytest.raises(rag_chat.ChatError, match="context overflow"):
        next(gen)


def test_stream_chat_sends_bearer_when_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def fake_urlopen(req, timeout):  # noqa: ARG001
        captured["headers"] = {k.lower(): v for k, v in req.header_items()}
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeStreamResp(_sse("data: [DONE]"))

    monkeypatch.setattr(rag_chat, "urlopen", fake_urlopen)
    list(
        rag_chat.stream_chat(
            "http://test/v1",
            "model-x",
            "sk-secret",
            [{"role": "user", "content": "x"}],
        )
    )
    assert captured["headers"].get("authorization") == "Bearer sk-secret"
    assert captured["body"]["stream"] is True
    assert captured["body"]["model"] == "model-x"


def test_stream_chat_includes_num_ctx_option_when_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def capture(req, timeout):  # noqa: ARG001
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeStreamResp(_sse(_delta("ok"), "data: [DONE]"))

    monkeypatch.setattr(rag_chat, "urlopen", capture)
    list(
        rag_chat.stream_chat(
            "http://test/v1",
            "m",
            "",
            [{"role": "user", "content": "x"}],
            num_ctx=16384,
        )
    )
    assert captured["body"]["options"] == {"num_ctx": 16384}


def test_stream_chat_omits_options_when_num_ctx_is_zero_or_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def capture(req, timeout):  # noqa: ARG001
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeStreamResp(_sse(_delta("ok"), "data: [DONE]"))

    monkeypatch.setattr(rag_chat, "urlopen", capture)
    list(
        rag_chat.stream_chat(
            "http://test/v1",
            "m",
            "",
            [{"role": "user", "content": "x"}],
            num_ctx=0,
        )
    )
    assert "options" not in captured["body"]


# ---- endpoint kind detection ------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:11434/v1",
        "http://host.docker.internal:11434/v1",
        "http://127.0.0.1:11434",
        "http://192.168.1.50:11434/v1/",
        "http://my-ollama.lan:11434/api",
    ],
)
def test_detect_endpoint_kind_ollama(url: str) -> None:
    assert rag_chat.detect_endpoint_kind(url) == "ollama"


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:1234/v1",                   # LM Studio
        "http://host.docker.internal:1234/v1",        # LM Studio in container
        "https://api.openai.com/v1",                  # OpenAI
        "http://localhost:8000/v1",                   # vLLM / TGI
        "not-even-a-url",
    ],
)
def test_detect_endpoint_kind_openai_default(url: str) -> None:
    assert rag_chat.detect_endpoint_kind(url) == "openai"


# ---- Ollama native /api/chat path -------------------------------------


def _ndjson(*messages: dict) -> list[bytes]:
    return [(json.dumps(m) + "\n").encode("utf-8") for m in messages]


def test_stream_chat_routes_ollama_url_through_native_api(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def capture(req, timeout):  # noqa: ARG001
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeStreamResp(
            _ndjson(
                {"message": {"content": "hi"}, "done": False},
                {"message": {"content": " there"}, "done": True},
            )
        )

    monkeypatch.setattr(rag_chat, "urlopen", capture)
    out = list(
        rag_chat.stream_chat(
            "http://localhost:11434/v1",  # Ollama URL → native routing
            "mistral",
            "",
            [{"role": "user", "content": "hello"}],
            num_ctx=8192,
        )
    )
    assert out == ["hi", " there"]
    # /v1 stripped, /api/chat appended.
    assert captured["url"] == "http://localhost:11434/api/chat"
    # num_ctx and temperature both ride inside `options`.
    assert captured["body"]["options"]["num_ctx"] == 8192
    assert "temperature" in captured["body"]["options"]
    assert captured["body"]["stream"] is True


def test_stream_chat_explicit_openai_kind_skips_native_routing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Even on an Ollama URL, an explicit kind override should win —
    # lets users with an OpenAI-compat layer on port 11434 use it.
    captured: dict = {}

    def capture(req, timeout):  # noqa: ARG001
        captured["url"] = req.full_url
        return _FakeStreamResp(_sse(_delta("ok"), "data: [DONE]"))

    monkeypatch.setattr(rag_chat, "urlopen", capture)
    list(
        rag_chat.stream_chat(
            "http://localhost:11434/v1",
            "m",
            "",
            [{"role": "user", "content": "x"}],
            endpoint_kind="openai",
        )
    )
    assert captured["url"].endswith("/chat/completions")


def test_stream_chat_ollama_native_raises_on_in_stream_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rag_chat,
        "urlopen",
        lambda req, timeout: _FakeStreamResp(  # noqa: ARG005
            _ndjson({"error": "model failed to load"})
        ),
    )
    with pytest.raises(rag_chat.ChatError, match="model failed to load"):
        list(
            rag_chat.stream_chat(
                "http://localhost:11434",
                "m",
                "",
                [{"role": "user", "content": "x"}],
            )
        )


def test_stream_chat_ollama_native_stops_on_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # done=True must terminate even if more lines arrive afterwards.
    monkeypatch.setattr(
        rag_chat,
        "urlopen",
        lambda req, timeout: _FakeStreamResp(  # noqa: ARG005
            _ndjson(
                {"message": {"content": "first"}, "done": False},
                {"message": {"content": ""}, "done": True},
                {"message": {"content": "after-done"}, "done": False},
            )
        ),
    )
    out = list(
        rag_chat.stream_chat(
            "http://localhost:11434",
            "m",
            "",
            [{"role": "user", "content": "x"}],
        )
    )
    assert out == ["first"]
