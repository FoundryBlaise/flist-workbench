"""rag_expand tests — labels_llm.call_llm is monkeypatched."""

from __future__ import annotations

import pytest

import labels_llm
import rag as rag_settings
import rag_expand


def _settings() -> rag_settings.RagSettings:
    return rag_settings.RagSettings(
        embed_endpoint="http://e/v1",
        embed_model="e",
        embed_api_key="",
        embed_query_prefix="",
        embed_document_prefix="",
        chat_endpoint="http://c/v1",
        chat_model="c",
        chat_api_key="",
        chat_system_prompt="",
        rerank_model="disabled",
        rerank_candidates=30,
        top_k=5,
        neighbors=1,
        rerank_min_ratio=0.0,
        hybrid_enabled=False,
        hybrid_bm25_candidates=30,
        multiquery_enabled=True,
        multiquery_variants=3,
        chat_num_ctx=0,
        chat_embed_keep_alive="",
        chunk_max_chars=5000,
        chunk_soft_split_chars=4000,
        chunk_overlap_msgs=1,
    )


def _stub_llm(monkeypatch: pytest.MonkeyPatch, response: str) -> list[str]:
    """Replace labels_llm.call_llm and return a list that captures the
    user prompts sent — handy for asserting we passed the right thing."""
    captured: list[str] = []

    def fake_call_llm(_endpoint, _model, _api_key, _system, user, **_kwargs):
        captured.append(user)
        return response

    monkeypatch.setattr(labels_llm, "call_llm", fake_call_llm)
    return captured


# ---- happy path -------------------------------------------------------


def test_expand_returns_clean_json_array(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_llm(monkeypatch, '["Wer ist Ophelia?", "Beschreibe Ophelia"]')
    out = rag_expand.expand_query("Wer ist Orphelia?", n=3, rag_set=_settings())
    assert out == ["Wer ist Ophelia?", "Beschreibe Ophelia"]


def test_expand_strips_markdown_fences(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_llm(monkeypatch, '```json\n["one", "two"]\n```')
    assert rag_expand.expand_query("q?", n=3, rag_set=_settings()) == ["one", "two"]


def test_expand_skips_preface_before_array(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_llm(monkeypatch, 'Sure! Here are variants:\n["x", "y", "z"]')
    out = rag_expand.expand_query("q?", n=5, rag_set=_settings())
    assert out == ["x", "y", "z"]


# ---- dedup + cap ------------------------------------------------------


def test_expand_drops_variants_matching_the_original(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_llm(monkeypatch, '["Wer ist Amber?", "  Wer ist Amber?  ", "Beschreibe Amber"]')
    out = rag_expand.expand_query("Wer ist Amber?", n=3, rag_set=_settings())
    assert out == ["Beschreibe Amber"]


def test_expand_caps_at_n(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_llm(monkeypatch, '["a", "b", "c", "d", "e", "f"]')
    out = rag_expand.expand_query("q?", n=3, rag_set=_settings())
    assert out == ["a", "b", "c"]


def test_expand_clamps_n_into_2_to_5(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _stub_llm(monkeypatch, '["a", "b"]')
    rag_expand.expand_query("q?", n=99, rag_set=_settings())
    # Prompt body should include the clamped N=5 not the raw 99.
    assert "N=5" in captured[0]


# ---- graceful failure -------------------------------------------------


def test_expand_returns_empty_on_llm_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a, **_k):
        raise RuntimeError("network down")

    monkeypatch.setattr(labels_llm, "call_llm", boom)
    assert rag_expand.expand_query("q", n=3, rag_set=_settings()) == []


def test_expand_returns_empty_on_unparsable_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_llm(monkeypatch, "I don't understand the request, sorry!")
    assert rag_expand.expand_query("q", n=3, rag_set=_settings()) == []


def test_expand_falls_back_to_bullet_list_parsing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_llm(monkeypatch, "- first variant\n- second variant\n- third variant")
    out = rag_expand.expand_query("q?", n=3, rag_set=_settings())
    assert out == ["first variant", "second variant", "third variant"]
