from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import labels as labels_store
import settings as settings_store


# ---- helpers ------------------------------------------------------------


def _msg(ts: int = 1_700_000_000, speaker: str = "Alice", raw: str = "hello world",
         text: str | None = None) -> dict:
    return {
        "ts": ts,
        "iso": "2023-11-14T22:13:20+00:00",
        "type": 0,
        "type_name": "chat",
        "speaker": speaker,
        "raw": raw,
        "text": text if text is not None else raw,
        "mentions": [],
        "kind": "ic",
    }


def _settings(threshold: int = 200) -> labels_store.LabelsSettings:
    return labels_store.LabelsSettings(
        threshold_chars=threshold,
        llm_endpoint=labels_store.DEFAULT_LLM_ENDPOINT,
        llm_model=labels_store.DEFAULT_LLM_MODEL,
        llm_api_key="",
        system_prompt=labels_store.DEFAULT_SYSTEM_PROMPT,
        context_before=labels_store.DEFAULT_CONTEXT_BEFORE,
        context_after=labels_store.DEFAULT_CONTEXT_AFTER,
    )


# ---- resolver -----------------------------------------------------------


def test_resolve_unlabeled_when_long_chat_and_no_db_row() -> None:
    long_text = "A" * 250
    assert labels_store.resolve(_msg(text=long_text, raw=long_text), None, _settings()) == "Unlabeled"


def test_resolve_short_text_is_ooc() -> None:
    short = "ok thanks"
    assert labels_store.resolve(_msg(text=short, raw=short), None, _settings()) == "OOC"


def test_resolve_empty_text_is_ooc() -> None:
    assert labels_store.resolve(_msg(text="   ", raw="   "), None, _settings()) == "OOC"


def test_resolve_parens_prefix_is_ooc_even_when_long() -> None:
    long_parens = "(( " + ("brb sorry " * 30) + "))"
    assert labels_store.resolve(_msg(text=long_parens, raw=long_parens), None, _settings()) == "OOC"


def test_resolve_db_row_overrides_rules() -> None:
    # A "long enough" message that rules would leave Unlabeled gets
    # forced to IC by an explicit DB row.
    long_text = "A" * 250
    fake_row = {"label": "IC", "source": "llm", "confidence": 0.9}
    assert labels_store.resolve(_msg(text=long_text, raw=long_text), fake_row, _settings()) == "IC"


def test_resolve_db_row_wins_even_over_short_rule() -> None:
    # A short message would be rule:short → OOC, but a manual label
    # forces it back to IC.
    short = "ok"
    fake_row = {"label": "IC", "source": "manual", "confidence": 1.0}
    assert labels_store.resolve(_msg(text=short, raw=short), fake_row, _settings()) == "IC"


def test_resolve_threshold_is_live() -> None:
    # 250-char text: Unlabeled at threshold=200, OOC at threshold=300.
    text = "A" * 250
    msg = _msg(text=text, raw=text)
    assert labels_store.resolve(msg, None, _settings(threshold=200)) == "Unlabeled"
    assert labels_store.resolve(msg, None, _settings(threshold=300)) == "OOC"


# ---- msg_hash determinism ----------------------------------------------


def test_msg_hash_is_deterministic_and_short() -> None:
    a = labels_store.msg_hash(_msg(ts=42, speaker="A", raw="x"))
    b = labels_store.msg_hash(_msg(ts=42, speaker="A", raw="x"))
    assert a == b
    assert len(a) == 16


def test_msg_hash_differs_on_any_input_change() -> None:
    base = _msg(ts=42, speaker="A", raw="x")
    assert labels_store.msg_hash(base) != labels_store.msg_hash({**base, "ts": 43})
    assert labels_store.msg_hash(base) != labels_store.msg_hash({**base, "speaker": "B"})
    assert labels_store.msg_hash(base) != labels_store.msg_hash({**base, "raw": "y"})


# ---- DB layer -----------------------------------------------------------


def _db(tmp_path: Path):
    return labels_store.connect(root=tmp_path)


def test_upsert_then_get_returns_label(tmp_path: Path) -> None:
    conn = _db(tmp_path)
    try:
        labels_store.upsert_label(
            conn, hash="abc", character="Char", partner="Bob",
            ts=1, speaker="Bob", label="IC", source="llm",
            confidence=0.85, reason="long narrative",
        )
        rows = labels_store.labels_for_partner(conn, "Char", "Bob")
        assert "abc" in rows
        assert rows["abc"]["label"] == "IC"
        assert rows["abc"]["confidence"] == 0.85
        assert rows["abc"]["source"] == "llm"
        assert rows["abc"]["prior_label"] is None
    finally:
        conn.close()


def test_upsert_snapshots_prior_label_on_override(tmp_path: Path) -> None:
    conn = _db(tmp_path)
    try:
        labels_store.upsert_label(
            conn, hash="h1", character="C", partner="P",
            ts=1, speaker="P", label="IC", source="llm",
        )
        labels_store.upsert_label(
            conn, hash="h1", character="C", partner="P",
            ts=1, speaker="P", label="OOC", source="manual",
        )
        rows = labels_store.labels_for_partner(conn, "C", "P")
        assert rows["h1"]["label"] == "OOC"
        assert rows["h1"]["source"] == "manual"
        assert rows["h1"]["prior_label"] == "IC"
        assert rows["h1"]["prior_source"] == "llm"
    finally:
        conn.close()


def test_upsert_rejects_invalid_label(tmp_path: Path) -> None:
    conn = _db(tmp_path)
    try:
        with pytest.raises(ValueError):
            labels_store.upsert_label(
                conn, hash="h", character="C", partner="P",
                ts=1, speaker="P", label="MAYBE", source="manual",
            )
        with pytest.raises(ValueError):
            labels_store.upsert_label(
                conn, hash="h", character="C", partner="P",
                ts=1, speaker="P", label="IC", source="bogus",
            )
    finally:
        conn.close()


def test_delete_label_reverts_to_resolver(tmp_path: Path) -> None:
    conn = _db(tmp_path)
    try:
        labels_store.upsert_label(
            conn, hash="h", character="C", partner="P",
            ts=1, speaker="P", label="IC", source="manual",
        )
        assert labels_store.delete_label(conn, "h") is True
        assert labels_store.delete_label(conn, "h") is False  # already gone
        assert labels_store.labels_for_partner(conn, "C", "P") == {}
    finally:
        conn.close()


def test_delete_labels_for_partner_scopes_correctly(tmp_path: Path) -> None:
    """Bulk delete clears just the targeted conversation, not others."""
    conn = _db(tmp_path)
    try:
        # Three labels: two for (C, P), one for (C, Q). The Q row must
        # survive a delete on P.
        for h, p in (("h1", "P"), ("h2", "P"), ("h3", "Q")):
            labels_store.upsert_label(
                conn, hash=h, character="C", partner=p,
                ts=1, speaker="S", label="IC", source="llm", confidence=0.9,
            )
        deleted = labels_store.delete_labels_for_partner(conn, "C", "P")
        assert deleted == 2
        assert labels_store.labels_for_partner(conn, "C", "P") == {}
        # Q untouched
        assert "h3" in labels_store.labels_for_partner(conn, "C", "Q")
        # Idempotent: second call returns 0
        assert labels_store.delete_labels_for_partner(conn, "C", "P") == 0
    finally:
        conn.close()


def test_stats_counts_three_buckets(tmp_path: Path) -> None:
    conn = _db(tmp_path)
    try:
        # One long unlabeled, one short (OOC), one with an IC DB row.
        long_text = "A" * 250
        m_long = _msg(ts=10, speaker="A", raw=long_text, text=long_text)
        m_short = _msg(ts=20, speaker="A", raw="ok", text="ok")
        m_db_ic = _msg(ts=30, speaker="A", raw=long_text, text=long_text)
        labels_store.upsert_label(
            conn, hash=labels_store.msg_hash(m_db_ic),
            character="C", partner="P", ts=30, speaker="A",
            label="IC", source="llm", confidence=0.9,
        )
        counts = labels_store.stats(conn, "C", "P", [m_long, m_short, m_db_ic], _settings())
        assert counts == {"IC": 1, "OOC": 1, "Unlabeled": 1}
    finally:
        conn.close()


# ---- settings loader ----------------------------------------------------


def test_load_settings_falls_back_to_defaults(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    conn = settings_store.connect()
    try:
        s = labels_store.load_settings(conn)
        assert s.threshold_chars == labels_store.DEFAULT_THRESHOLD_CHARS
        assert s.llm_endpoint == labels_store.DEFAULT_LLM_ENDPOINT
        assert s.llm_model == labels_store.DEFAULT_LLM_MODEL
        assert s.llm_api_key == ""
        # The default prompt is long German text; just sanity-check it's there.
        assert "Klassifikator" in s.system_prompt
    finally:
        conn.close()


def test_load_settings_reads_stored_overrides(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    conn = settings_store.connect()
    try:
        settings_store.set_value(conn, settings_store.KEY_LABELS_THRESHOLD_CHARS, "300")
        settings_store.set_value(
            conn, settings_store.KEY_LABELS_LLM_ENDPOINT, "http://localhost:11434/v1"
        )
        settings_store.set_value(conn, settings_store.KEY_LABELS_LLM_MODEL, "llama3")
        settings_store.set_value(conn, settings_store.KEY_LABELS_LLM_API_KEY, "sk-test")
        settings_store.set_value(
            conn, settings_store.KEY_LABELS_SYSTEM_PROMPT, "be a helpful classifier"
        )
        s = labels_store.load_settings(conn)
        assert s.threshold_chars == 300
        assert s.llm_endpoint == "http://localhost:11434/v1"
        assert s.llm_model == "llama3"
        assert s.llm_api_key == "sk-test"
        assert s.system_prompt == "be a helpful classifier"
    finally:
        conn.close()


def test_load_settings_treats_empty_as_unset(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    conn = settings_store.connect()
    try:
        settings_store.set_value(conn, settings_store.KEY_LABELS_SYSTEM_PROMPT, "")
        s = labels_store.load_settings(conn)
        # Empty stored value falls back to default — that's how "Reset"
        # works from the UI.
        assert s.system_prompt == labels_store.DEFAULT_SYSTEM_PROMPT
    finally:
        conn.close()


# ---- API integration ----------------------------------------------------


@pytest.fixture
def api_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    from server import app

    return TestClient(app)


def test_settings_get_exposes_labels_and_defaults(api_client: TestClient) -> None:
    res = api_client.get("/settings").json()
    assert "labels" in res
    lab = res["labels"]
    assert lab["threshold_chars"] == labels_store.DEFAULT_THRESHOLD_CHARS
    assert lab["llm_endpoint"] == labels_store.DEFAULT_LLM_ENDPOINT
    assert lab["llm_model"] == labels_store.DEFAULT_LLM_MODEL
    # Defaults block is mirrored so the UI can do "Reset" without
    # hardcoding strings.
    assert lab["defaults"]["threshold_chars"] == labels_store.DEFAULT_THRESHOLD_CHARS
    assert "Klassifikator" in lab["defaults"]["system_prompt"]


def test_settings_put_persists_labels(api_client: TestClient) -> None:
    body = {"labels": {
        "threshold_chars": 350,
        "llm_endpoint": "http://localhost:11434/v1",
        "llm_model": "qwen2.5",
        "llm_api_key": "secret",
        "system_prompt": "custom prompt",
    }}
    res = api_client.put("/settings", json=body).json()
    lab = res["labels"]
    assert lab["threshold_chars"] == 350
    assert lab["llm_endpoint"] == "http://localhost:11434/v1"
    assert lab["llm_model"] == "qwen2.5"
    assert lab["llm_api_key"] == "secret"
    assert lab["system_prompt"] == "custom prompt"


def test_settings_put_empty_string_resets_to_default(api_client: TestClient) -> None:
    api_client.put("/settings", json={"labels": {"system_prompt": "override"}})
    res = api_client.put("/settings", json={"labels": {"system_prompt": ""}}).json()
    assert res["labels"]["system_prompt"] == labels_store.DEFAULT_SYSTEM_PROMPT


def test_settings_put_clamps_threshold_below_one(api_client: TestClient) -> None:
    res = api_client.put("/settings", json={"labels": {"threshold_chars": -5}}).json()
    assert res["labels"]["threshold_chars"] == 1


# ---- /labels/override ---------------------------------------------------


def _override_body(label: str | None = "IC", hash: str = "deadbeefdeadbeef") -> dict:
    return {
        "character": "Char",
        "partner": "Partner",
        "hash": hash,
        "ts": 1700000000,
        "speaker": "Partner",
        "label": label,
    }


def test_override_creates_manual_label(api_client: TestClient) -> None:
    res = api_client.post("/labels/override", json=_override_body("IC")).json()
    assert res["label"] == "IC"
    assert res["source"] == "manual"
    assert res["confidence"] == 1.0
    assert res["prior_label"] is None


def test_override_snapshots_prior_label(api_client: TestClient) -> None:
    api_client.post("/labels/override", json=_override_body("IC"))
    res = api_client.post("/labels/override", json=_override_body("OOC")).json()
    assert res["label"] == "OOC"
    # The previous manual IC becomes the prior snapshot.
    assert res["prior_label"] == "IC"
    assert res["prior_source"] == "manual"


def test_override_delete_with_null_label(api_client: TestClient) -> None:
    api_client.post("/labels/override", json=_override_body("IC"))
    res = api_client.post("/labels/override", json=_override_body(None)).json()
    assert res["label"] is None
    assert res["deleted"] is True
    # Deleting again is a no-op (idempotent).
    res = api_client.post("/labels/override", json=_override_body(None)).json()
    assert res["deleted"] is False


def test_override_rejects_invalid_label(api_client: TestClient) -> None:
    res = api_client.post("/labels/override", json=_override_body("MAYBE"))
    assert res.status_code == 400
    assert "IC or OOC" in res.json()["detail"]
