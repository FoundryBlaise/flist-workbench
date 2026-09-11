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
    return labels_store.LabelsSettings(threshold_chars=threshold)


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
            ts=1, speaker="Bob", label="IC", source="mcp",
            reason="long narrative",
        )
        rows = labels_store.labels_for_partner(conn, "Char", "Bob")
        assert "abc" in rows
        assert rows["abc"]["label"] == "IC"
        assert rows["abc"]["source"] == "mcp"
        assert rows["abc"]["prior_label"] is None
    finally:
        conn.close()


def test_upsert_snapshots_prior_label_on_override(tmp_path: Path) -> None:
    conn = _db(tmp_path)
    try:
        labels_store.upsert_label(
            conn, hash="h1", character="C", partner="P",
            ts=1, speaker="P", label="IC", source="mcp",
        )
        labels_store.upsert_label(
            conn, hash="h1", character="C", partner="P",
            ts=1, speaker="P", label="OOC", source="manual",
        )
        rows = labels_store.labels_for_partner(conn, "C", "P")
        assert rows["h1"]["label"] == "OOC"
        assert rows["h1"]["source"] == "manual"
        assert rows["h1"]["prior_label"] == "IC"
        assert rows["h1"]["prior_source"] == "mcp"
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
                ts=1, speaker="S", label="IC", source="mcp",
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
            label="IC", source="mcp",
        )
        counts = labels_store.stats(conn, "C", "P", [m_long, m_short, m_db_ic], _settings())
        assert counts == {"IC": 1, "OOC": 1, "Unlabeled": 1}
    finally:
        conn.close()


# ---- retired: the "Failed" state ---------------------------------------


def test_failed_state_is_gone(tmp_path: Path) -> None:
    """A message the model declines to judge simply stays Unlabeled and
    comes back in the next batch, so there is nothing to record."""
    conn = _db(tmp_path)
    try:
        tables = {
            r["name"]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        assert "label_failures" not in tables
        assert "label_jobs" not in tables
    finally:
        conn.close()
    assert not hasattr(labels_store, "record_failure")
    assert not hasattr(labels_store, "LABEL_FAILED")


def test_existing_databases_have_the_retired_tables_dropped(
    tmp_path: Path,
) -> None:
    """Upgrading over an install that still has them must clear them."""
    import sqlite3

    db = labels_store.db_path(tmp_path)
    raw = sqlite3.connect(db)
    raw.executescript(
        "CREATE TABLE label_failures (hash TEXT PRIMARY KEY);"
        "CREATE TABLE label_jobs (id TEXT PRIMARY KEY);"
    )
    raw.commit()
    raw.close()

    conn = labels_store.connect(tmp_path)
    try:
        tables = {
            r["name"]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        assert "label_failures" not in tables
        assert "label_jobs" not in tables
    finally:
        conn.close()


def test_existing_databases_accept_an_mcp_verdict(tmp_path: Path) -> None:
    """The old CHECK constraint only allowed 'llm' and 'manual', so the
    first verdict from a connected model would have failed on any
    install created before the migration."""
    import sqlite3

    db = labels_store.db_path(tmp_path)
    raw = sqlite3.connect(db)
    raw.executescript(
        """
        CREATE TABLE labels (
            hash TEXT PRIMARY KEY, character TEXT NOT NULL,
            partner TEXT NOT NULL, ts INTEGER NOT NULL,
            speaker TEXT NOT NULL,
            label TEXT NOT NULL CHECK (label IN ('IC','OOC')),
            confidence REAL NOT NULL, reason TEXT,
            source TEXT NOT NULL CHECK (source IN ('llm','manual')),
            prior_label TEXT, prior_source TEXT, updated_at REAL NOT NULL
        );
        INSERT INTO labels VALUES
            ('old', 'C', 'P', 1, 'A', 'IC', 1.0, NULL, 'llm', NULL, NULL, 1.0);
        """
    )
    raw.commit()
    raw.close()

    conn = labels_store.connect(tmp_path)
    try:
        labels_store.upsert_label(
            conn, hash="fresh", character="C", partner="P",
            ts=2, speaker="A", label="OOC", source="mcp",
        )
        rows = labels_store.labels_for_partner(conn, "C", "P")
        # The pre-existing row survived the table rebuild.
        assert set(rows) == {"old", "fresh"}
        assert rows["old"]["source"] == "llm"
        assert rows["fresh"]["source"] == "mcp"
    finally:
        conn.close()


# ---- settings loader ----------------------------------------------------


def test_load_settings_falls_back_to_defaults(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    conn = settings_store.connect()
    try:
        s = labels_store.load_settings(conn)
        assert s.threshold_chars == labels_store.DEFAULT_THRESHOLD_CHARS
    finally:
        conn.close()


def test_load_settings_reads_stored_overrides(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    conn = settings_store.connect()
    try:
        settings_store.set_value(conn, settings_store.KEY_LABELS_THRESHOLD_CHARS, "300")
        s = labels_store.load_settings(conn)
        assert s.threshold_chars == 300
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
    # Defaults block is mirrored so the UI can do "Reset" without
    # hardcoding numbers.
    assert lab["defaults"]["threshold_chars"] == labels_store.DEFAULT_THRESHOLD_CHARS


def test_settings_put_persists_labels(api_client: TestClient) -> None:
    res = api_client.put(
        "/settings", json={"labels": {"threshold_chars": 350}}
    ).json()
    assert res["labels"]["threshold_chars"] == 350


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
    assert "confidence" not in res
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
