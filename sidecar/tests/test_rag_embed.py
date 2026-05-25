"""rag_embed tests — mock the HTTP layer so we don't need a live LM Studio."""

from __future__ import annotations

import io
import json
from typing import Any

import pytest

import rag_embed
from rag import RagSettings


def _settings(
    *,
    endpoint: str = "http://test/v1",
    model: str = "test-model",
    api_key: str = "",
    qp: str = "",
    dp: str = "",
) -> RagSettings:
    return RagSettings(
        embed_endpoint=endpoint,
        embed_model=model,
        embed_api_key=api_key,
        embed_query_prefix=qp,
        embed_document_prefix=dp,
    )


class _FakeResponse:
    def __init__(self, payload: dict) -> None:
        self._buf = io.BytesIO(json.dumps(payload).encode("utf-8"))

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *exc: Any) -> None:  # noqa: ANN401
        pass

    def read(self) -> bytes:
        return self._buf.read()


def test_embed_texts_sends_model_and_input(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_urlopen(req, timeout):  # noqa: ANN001
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        captured["headers"] = {k: v for k, v in req.header_items()}
        captured["timeout"] = timeout
        n = len(captured["body"]["input"])
        return _FakeResponse(
            {"data": [{"index": i, "embedding": [float(i)] * 3} for i in range(n)]}
        )

    monkeypatch.setattr(rag_embed, "urlopen", fake_urlopen)

    out = rag_embed.embed_texts(["a", "b"], "document", _settings())
    assert out == [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]]
    assert captured["url"] == "http://test/v1/embeddings"
    assert captured["body"]["model"] == "test-model"
    assert captured["body"]["input"] == ["a", "b"]
    # No api_key configured → no Authorization header at all.
    assert "Authorization" not in captured["headers"]


def test_embed_texts_applies_document_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_urlopen(req, timeout):  # noqa: ANN001
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResponse({"data": [{"index": 0, "embedding": [1.0]}]})

    monkeypatch.setattr(rag_embed, "urlopen", fake_urlopen)
    rag_embed.embed_texts(
        ["hello"], "document", _settings(dp="search_document: ", qp="search_query: ")
    )
    assert captured["body"]["input"] == ["search_document: hello"]


def test_embed_texts_applies_query_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_urlopen(req, timeout):  # noqa: ANN001
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResponse({"data": [{"index": 0, "embedding": [1.0]}]})

    monkeypatch.setattr(rag_embed, "urlopen", fake_urlopen)
    rag_embed.embed_texts(
        ["who is X?"],
        "query",
        _settings(dp="search_document: ", qp="search_query: "),
    )
    assert captured["body"]["input"] == ["search_query: who is X?"]


def test_embed_texts_batches(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def fake_urlopen(req, timeout):  # noqa: ANN001
        body = json.loads(req.data.decode("utf-8"))
        calls.append(body["input"])
        return _FakeResponse(
            {"data": [{"index": i, "embedding": [0.0]} for i in range(len(body["input"]))]}
        )

    monkeypatch.setattr(rag_embed, "urlopen", fake_urlopen)
    rag_embed.embed_texts(
        [f"t{i}" for i in range(5)], "document", _settings(), batch=2
    )
    # 5 inputs at batch=2 → 3 calls: [t0,t1], [t2,t3], [t4].
    assert [len(c) for c in calls] == [2, 2, 1]


def test_embed_texts_sets_bearer_when_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_urlopen(req, timeout):  # noqa: ANN001
        captured["headers"] = {k.lower(): v for k, v in req.header_items()}
        return _FakeResponse({"data": [{"index": 0, "embedding": [1.0]}]})

    monkeypatch.setattr(rag_embed, "urlopen", fake_urlopen)
    rag_embed.embed_texts(["x"], "document", _settings(api_key="sk-secret"))
    assert captured["headers"].get("authorization") == "Bearer sk-secret"


def test_embed_texts_empty_input_short_circuits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom(*a: Any, **kw: Any) -> None:  # noqa: ANN401
        raise AssertionError("should not be called")

    monkeypatch.setattr(rag_embed, "urlopen", boom)
    assert rag_embed.embed_texts([], "document", _settings()) == []


def test_embed_texts_raises_embed_error_on_url_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from urllib.error import URLError

    def boom(req, timeout):  # noqa: ANN001
        raise URLError("Connection refused")

    monkeypatch.setattr(rag_embed, "urlopen", boom)
    with pytest.raises(rag_embed.EmbedError, match="Connection refused"):
        rag_embed.embed_texts(["x"], "document", _settings())


def test_embed_texts_raises_embed_error_on_http_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from urllib.error import HTTPError

    def boom(req, timeout):  # noqa: ANN001
        raise HTTPError(
            req.full_url,
            404,
            "Not Found",
            {},
            io.BytesIO(b'{"error":"model not loaded"}'),
        )

    monkeypatch.setattr(rag_embed, "urlopen", boom)
    with pytest.raises(rag_embed.EmbedError, match="404"):
        rag_embed.embed_texts(["x"], "document", _settings())


def test_embed_texts_raises_on_mismatched_response_length(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_urlopen(req, timeout):  # noqa: ANN001
        return _FakeResponse({"data": [{"index": 0, "embedding": [1.0]}]})

    monkeypatch.setattr(rag_embed, "urlopen", fake_urlopen)
    # Two inputs requested, one returned — must surface as EmbedError.
    with pytest.raises(rag_embed.EmbedError, match="requested 2"):
        rag_embed.embed_texts(["a", "b"], "document", _settings())


def test_probe_returns_dimension(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_urlopen(req, timeout):  # noqa: ANN001
        return _FakeResponse(
            {"data": [{"index": 0, "embedding": [0.1] * 384}]}
        )

    monkeypatch.setattr(rag_embed, "urlopen", fake_urlopen)
    dim, vec = rag_embed.probe(_settings())
    assert dim == 384
    assert len(vec) == 384
