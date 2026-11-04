"""The Label and settings databases carry a schema version and migrate by it.

The starting points are databases as released builds left them, built
by those builds' own code and kept as SQL under
`fixtures/databases/<release>/`: v0.2.16 (the current release, before
versioning) and v0.1.10 (the oldest shape still handled, with the
in-app classifier's tables and its narrower `source` CHECK).
"""

from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import aliases as aliases_store
import labels as labels_store
import rag_lexical
import rag_store
import settings as settings_store
from sidecar_client import app_client

FIXTURES = Path(__file__).parent / "fixtures" / "databases"
RELEASES = ("v0.2.16", "v0.1.10")


def _restore(release: str, name: str, root: Path) -> Path:
    """Write `<name>.db` under `root` as `release` left it."""
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"{name}.db"
    db = sqlite3.connect(target)
    db.executescript((FIXTURES / release / f"{name}.sql").read_text(encoding="utf-8"))
    db.close()
    return target


def _user_version(path: Path) -> int:
    db = sqlite3.connect(path)
    try:
        return db.execute("PRAGMA user_version").fetchone()[0]
    finally:
        db.close()


# ---- labels.db -------------------------------------------------------------


@pytest.mark.parametrize("release", RELEASES)
def test_an_unversioned_label_database_migrates_with_its_data_intact(
    release: str, tmp_path: Path
) -> None:
    path = _restore(release, "labels", tmp_path)

    conn = aliases_store.connect(tmp_path)
    try:
        kept = labels_store.label_row(conn, "h-manual")
        assert kept["label"] == "IC"
        assert kept["source"] == "manual"
        assert kept["prior_label"] == "OOC"
        assert aliases_store.all_names_for(conn, "Ayla", "Brin Old") == ["Brin", "Brin Old"]
        # A connected model's verdict is accepted, whatever the old CHECK said.
        labels_store.upsert_label(
            conn, hash="h-new", ts=1700000200, speaker="Brin", label="OOC", source="mcp",
        )
        assert labels_store.label_row(conn, "h-new")["source"] == "mcp"
        tables = {
            r["name"]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        assert not tables & {"label_failures", "label_jobs"}
    finally:
        conn.close()

    manifest = rag_store.read_manifest(root=tmp_path)
    assert manifest.embed_dimension in (384, 1024)
    with rag_lexical.LexicalStore(root=tmp_path) as lex:
        hits = lex.search("lantern harbour")
    assert [h.chunk_id for h in hits] == ["Ayla|Brin|2023-11-14|0"]

    assert _user_version(path) == labels_store.SCHEMA_VERSION > 0


def _verdicts(path: Path) -> dict[str, tuple]:
    """Every stored Label of the database at `path`, by message hash:
    the verdict, who gave it and the Label it replaced."""
    db = sqlite3.connect(path)
    try:
        return {
            row[0]: row[1:]
            for row in db.execute(
                "SELECT hash, ts, speaker, label, reason, source, prior_label,"
                " prior_source, updated_at FROM labels"
            )
        }
    finally:
        db.close()


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The app's data folder, so the data invariants hold the test to
    keeping what the user owns."""
    data = tmp_path / "wb"
    data.mkdir()
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(data))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    return data


@pytest.mark.parametrize("release", RELEASES)
def test_a_label_no_longer_stores_a_character_or_partner(
    release: str, data_dir: Path
) -> None:
    """A Label belongs to the message (ADR 0004): the owner columns and
    their index go, every verdict stays as it was."""
    path = _restore(release, "labels", data_dir)
    before = _verdicts(path)

    labels_store.connect(data_dir).close()

    db = sqlite3.connect(path)
    try:
        columns = {row[1] for row in db.execute("PRAGMA table_info(labels)")}
        indexes = {row[1] for row in db.execute("PRAGMA index_list(labels)")}
    finally:
        db.close()
    assert not columns & {"character", "partner"}
    assert "idx_labels_partner" not in indexes
    assert _verdicts(path) == before


def _old_trash_entry(path: Path, root: Path) -> str:
    """Clear every Label of the old database at `path` the way releases
    before the migration did: each row, character and partner included,
    kept in a Trash entry under `root`, then deleted. Returns its id."""
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    try:
        rows = [dict(r) for r in db.execute("SELECT * FROM labels ORDER BY ts")]
        db.execute("DELETE FROM labels")
        db.commit()
    finally:
        db.close()
    assert rows and all({"character", "partner"} <= set(r) for r in rows)
    trash_id = "1793000000-0123456789ab"
    folder = root / "trash" / "labels"
    folder.mkdir(parents=True)
    (folder / f"{trash_id}.json").write_text(
        json.dumps(
            {
                "id": trash_id,
                "character": "Ayla",
                "partner": None,
                "count": len(rows),
                "deleted_at": 1793000000,
                "deleted_by": "ui",
                "labels": rows,
            }
        ),
        encoding="utf-8",
    )
    return trash_id


@pytest.mark.parametrize("release", RELEASES)
def test_labels_cleared_before_the_migration_can_be_put_back_after_it(
    release: str, data_dir: Path
) -> None:
    path = _restore(release, "labels", data_dir)
    before = _verdicts(path)
    trash_id = _old_trash_entry(path, data_dir)
    from server import app

    client = app_client(app)

    res = client.post("/labels/trash/put-back", json={"ids": [trash_id]})

    assert res.status_code == 200, res.text
    assert res.json()["restored"] == [
        {"id": trash_id, "restored": len(before), "skipped": []}
    ]
    assert _verdicts(path) == before
    assert _user_version(path) == labels_store.SCHEMA_VERSION


def test_two_verdicts_on_one_message_merge_into_the_one_that_wins(
    data_dir: Path,
) -> None:
    """Should an older database ever hold more than one verdict for a
    message, a manual Label beats a model's, and within one source the
    newer verdict beats the older."""
    # A labels table whose hash is not unique, at the version before
    # the owner columns were dropped.
    path = _restore("v0.2.16", "labels", data_dir)
    db = sqlite3.connect(path)
    db.executescript(
        """
        ALTER TABLE labels RENAME TO labels_keyed;
        CREATE TABLE labels AS SELECT * FROM labels_keyed;
        DROP TABLE labels_keyed;
        INSERT INTO labels VALUES
            ('h-manual', 'Brin', 'Ayla', 1700000060, 'Ayla', 'OOC', 1.0,
             NULL, 'mcp', NULL, NULL, 1893456000.0),
            ('h-mcp', 'Brin', 'Ayla', 1700000000, 'Brin', 'OOC', 1.0,
             'newer', 'mcp', 'IC', 'mcp', 1893456000.0),
            ('h-llm', 'Cass', 'Ayla', 1690000000, 'Cass', 'IC', 1.0,
             'older', 'llm', NULL, NULL, 1600000000.0);
        PRAGMA user_version = 3;
        """
    )
    db.close()

    conn = labels_store.connect(data_dir)
    try:
        kept = {
            h: labels_store.label_row(conn, h) for h in ("h-manual", "h-mcp", "h-llm")
        }
        count = conn.execute("SELECT COUNT(*) FROM labels").fetchone()[0]
    finally:
        conn.close()

    assert count == 3
    # Manual beats a newer model verdict.
    assert (kept["h-manual"]["label"], kept["h-manual"]["source"]) == ("IC", "manual")
    assert kept["h-manual"]["prior_label"] == "OOC"
    # Within one source, the newer verdict wins with its own prior Label.
    assert (kept["h-mcp"]["label"], kept["h-mcp"]["reason"]) == ("OOC", "newer")
    assert kept["h-mcp"]["prior_label"] == "IC"
    # The older duplicate loses.
    assert (kept["h-llm"]["label"], kept["h-llm"]["reason"]) == ("OOC", None)


# ---- settings.db -----------------------------------------------------------


@pytest.mark.parametrize("release", RELEASES)
def test_an_unversioned_settings_database_migrates_with_its_data_intact(
    release: str, tmp_path: Path
) -> None:
    path = _restore(release, "settings", tmp_path)

    conn = settings_store.connect(tmp_path)
    try:
        kept = settings_store.all_settings(conn)
    finally:
        conn.close()

    assert kept["fchat_data_dir"] == "C:/FChat/data"
    assert kept["labels.threshold_chars"] == "40"
    assert "rag.embed_model" in kept
    # Keys of removed features are gone, the old API key included.
    assert not set(kept) & set(settings_store.RETIRED_KEYS)
    assert _user_version(path) == settings_store.SCHEMA_VERSION > 0


# ---- once only -------------------------------------------------------------


@pytest.mark.parametrize("name", ["labels", "settings"])
def test_a_second_connect_leaves_a_migrated_database_untouched(
    name: str, tmp_path: Path
) -> None:
    path = _restore("v0.1.10", name, tmp_path)
    connect = {"labels": labels_store.connect, "settings": settings_store.connect}[name]
    connect(tmp_path).close()
    migrated = path.read_bytes()

    connect(tmp_path).close()

    assert path.read_bytes() == migrated


def test_a_finished_migration_does_not_run_again(tmp_path: Path) -> None:
    """A row an old step would remove, written after it ran (an older
    release run in between, say), stays: steps run once, by version."""
    _restore("v0.2.16", "settings", tmp_path)
    settings_store.connect(tmp_path).close()
    raw = sqlite3.connect(settings_store.db_path(tmp_path))
    raw.execute("INSERT INTO settings VALUES ('backups.scheduled_interval_days', '3')")
    raw.commit()
    raw.close()

    conn = settings_store.connect(tmp_path)
    try:
        assert settings_store.get(conn, "backups.scheduled_interval_days") == "3"
    finally:
        conn.close()


# ---- concurrent use --------------------------------------------------------


def _lexical_conn(root: Path) -> sqlite3.Connection:
    return rag_lexical.LexicalStore(root=root)._conn


OPENERS = {
    "labels": labels_store.connect,
    "aliases": aliases_store.connect,
    "index manifest": rag_store._manifest_conn,
    "keyword index": _lexical_conn,
    "settings": settings_store.connect,
}


@pytest.mark.parametrize("opener", OPENERS.values(), ids=OPENERS.keys())
def test_every_connection_uses_wal_and_waits_for_a_busy_database(
    opener, tmp_path: Path
) -> None:
    conn = opener(tmp_path)
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] >= 5000
    finally:
        conn.close()


def test_a_label_write_while_an_ingest_reads_labels_goes_through(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    from server import app

    client = app_client(app)
    _restore("v0.2.16", "labels", tmp_path)

    # The ingest is partway through reading the Labels of a conversation.
    ingest = labels_store.connect()
    try:
        ingest.execute("BEGIN")
        reading = ingest.execute("SELECT hash FROM labels ORDER BY ts")
        assert reading.fetchone() is not None

        res = client.post(
            "/labels/override",
            json={
                "character": "Ayla", "partner": "Brin", "hash": "h-model",
                "ts": 1700000300, "speaker": "Brin", "label": "OOC",
            },
        )
        assert res.status_code == 200, res.text

        reading.fetchall()
        ingest.execute("COMMIT")
    finally:
        ingest.close()

    conn = labels_store.connect()
    try:
        assert labels_store.label_row(conn, "h-model")["label"] == "OOC"
    finally:
        conn.close()


def test_connections_opened_at_once_migrate_an_old_database_once(tmp_path: Path) -> None:
    """The window, a model and an ingest all open labels.db at start-up."""
    path = _restore("v0.1.10", "labels", tmp_path)
    openers = list(OPENERS.values())[:4] * 4

    def open_and_read(opener) -> int:
        conn = opener(tmp_path)
        try:
            return conn.execute("SELECT COUNT(*) FROM labels").fetchone()[0]
        finally:
            conn.close()

    with ThreadPoolExecutor(max_workers=len(openers)) as pool:
        counts = list(pool.map(open_and_read, openers))

    assert counts == [2] * len(openers)
    assert _user_version(path) == labels_store.SCHEMA_VERSION
