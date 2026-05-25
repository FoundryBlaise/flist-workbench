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
