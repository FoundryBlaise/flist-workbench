"""The Label and settings databases carry a schema version and migrate by it.

The starting points are databases as released builds left them, built
by those builds' own code and kept as SQL under
`fixtures/databases/<release>/`: v0.2.16 (the current release, before
versioning) and v0.1.10 (the oldest shape still handled, with the
in-app classifier's tables and its narrower `source` CHECK).
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

import aliases as aliases_store
import labels as labels_store
import rag_lexical
import rag_store
import settings as settings_store

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
        rows = labels_store.labels_for_partner(conn, "Ayla", "Brin")
        assert rows["h-manual"]["label"] == "IC"
        assert rows["h-manual"]["source"] == "manual"
        assert rows["h-manual"]["prior_label"] == "OOC"
        assert aliases_store.all_names_for(conn, "Ayla", "Brin Old") == ["Brin", "Brin Old"]
        # A connected model's verdict is accepted, whatever the old CHECK said.
        labels_store.upsert_label(
            conn, hash="h-new", character="Ayla", partner="Brin",
            ts=1700000200, speaker="Brin", label="OOC", source="mcp",
        )
        assert labels_store.labels_for_partner(conn, "Ayla", "Brin")["h-new"]["source"] == "mcp"
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
