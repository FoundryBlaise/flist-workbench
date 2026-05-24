"""IC/OOC labels store + read-time resolver.

Persists only **explicit** labels (LLM + manual). Rules are recomputed
at every read against the current settings, so changing the threshold
is instant — no DB rebuild needed. See `docs/RAG_DESIGN.md` for the
full design contract.

Resolver precedence:
    1. DB label (LLM or manual)             -> stored row's label
    2. empty body                           -> OOC  (rule:empty)
    3. text_len < settings.threshold_chars  -> OOC  (rule:short)
    4. body starts with "((" (LRP convention) -> OOC (rule:parens)
    5. otherwise                            -> Unlabeled

Storage path: <user_data_dir>/labels.db — separate from documents.db
so users can wipe it without losing their drafts and the LLM ingest
job can safely WAL the file under load.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import documents
import settings as settings_store

# Three-state result the resolver returns. The DB only ever stores IC
# or OOC; "Unlabeled" is what the resolver returns when no explicit
# label exists and no rule matched.
LABEL_IC = "IC"
LABEL_OOC = "OOC"
LABEL_UNLABELED = "Unlabeled"

DEFAULT_THRESHOLD_CHARS = 200
DEFAULT_LLM_ENDPOINT = "http://localhost:1234/v1"
DEFAULT_LLM_MODEL = "gemma-4-26b-a4b-it-uncensored-heretic"
DEFAULT_LLM_API_KEY = ""

# Default classifier prompt. Lifted from Chat_RAG/classify.py (German
# RP). Users can edit this in Settings → Labels; a blank stored value
# falls back to this default, so "reset to default" is just "save blank".
DEFAULT_SYSTEM_PROMPT = """Du bist ein Klassifikator für deutschsprachige Roleplay-Chat-Logs aus F-Chat.
Klassifiziere die ZIELNACHRICHT als "IC" (in-character, Teil des Roleplays) oder "OOC" (out-of-character, Spieler-zu-Spieler-Kommunikation).

WICHTIGSTE HEURISTIK — LÄNGE:
- Texte unter 200 Zeichen sind in ~99% der Fälle OOC, NICHT IC. Eine echte IC-Erzählung beschreibt Szene, Aktionen und Gefühle — das braucht meistens mehrere Sätze und 200+ Zeichen.
- Texte über 200 Zeichen sind häufig IC (Szenenerzählung), aber lange OOC-Diskussionen (über Szene, Charakter, Vorgeschichte, Kinks, Spielideen) sind ebenfalls möglich.
- Kurzer Text wird nur dann als IC klassifiziert, wenn er klar narrativ ist (dritte Person + Aktionsverb + Charaktername als Subjekt) ODER mit "|" beginnt.

IC-Merkmale:
- Erzählung in dritter Person mit Aktionsverben ("Sie öffnete die Tür", "Caylene hob den Blick")
- Beschreibung von Szene, Setting, Kleidung, Gefühlen
- Direkte Rede in der Erzählung ("...", sagte sie leise)
- Charaktername als grammatikalisches Subjekt
- Beginnt mit "|" → fast immer IC
- Langer Block (100+ Zeichen) in *...* oder **...** mit Erzählung → IC

OOC-Merkmale:
- Erste Person aus Spielerperspektive ("Ich finde Jackie würde...", "Wollen wir...?")
- Meta-Vokabular: Char, Kink, RP, IC, OOC, Spiel, Aufhänger, Vorgeschichte, looking, bookmark, post, scene, ad, Idee
- Direkte Anrede des Spielers (nicht zwischen Charakteren)
- Stage-Management: "kurz afk", "log mich um", "bis dann", "huhu"
- Smileys (":)", ":D", ":P", "^^"), kurze Reaktionen ("ja", "ok", "lol", "Mhmm", "stimmt")
- Kurze Emotes in *...* oder **...** mit 1-3 Wörtern (*winkt*, *beisst dich*, *lacht*) → beiläufige Spieler-Geste, KEIN RP
- Kurze /me-Aktionen wie "Charname piekst dich" → meistens OOC-Geste zwischen Spielern, KEIN RP

KONTEXT-NUTZUNG:
Vorherige und nachfolgende Nachrichten helfen bei mehrdeutigen Fällen. IC und OOC bilden meist Cluster — wenn die Nachbarn klar OOC sind (Smileys, Spielerchat, kurze Emotes), ist die Zielnachricht selten allein IC.

BEISPIELE:

NACHRICHT: "Dante Stirling piekst dich von der Seite an!"
ANTWORT: {"label":"OOC","confidence":0.95,"reason":"Kurze /me-Geste zwischen Spielern, kein RP"}

NACHRICHT: "*piekst von vorne zurück*"
ANTWORT: {"label":"OOC","confidence":0.95,"reason":"Kurzes Sternchen-Emote, beiläufige Geste"}

NACHRICHT: ":D"
ANTWORT: {"label":"OOC","confidence":1.0,"reason":"Reines Smiley"}

NACHRICHT: "Caylene legte sanft ihre seidige Hand auf das kühle Metall des Türgriffs, während das strahlende Mondlicht durch die hohen Fenster fiel und ihren weißen Mantel in einen silbrigen Glanz hüllte. Sie zog die Tür langsam auf und trat in den parfümierten Raum."
ANTWORT: {"label":"IC","confidence":0.95,"reason":"Lange Szenenerzählung in dritter Person mit Charakter"}

FORMAT (PFLICHT):
Antworte AUSSCHLIESSLICH mit gültigem JSON, kein Text davor oder dahinter, KEINE Code-Fences (kein ```).
{"label":"IC"|"OOC","confidence":0.0-1.0,"reason":"kurze Begründung max 80 Zeichen"}"""

SCHEMA = """
CREATE TABLE IF NOT EXISTS labels (
    hash         TEXT PRIMARY KEY,
    character    TEXT NOT NULL,
    partner      TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    speaker      TEXT NOT NULL,
    label        TEXT NOT NULL CHECK (label IN ('IC','OOC')),
    confidence   REAL NOT NULL,
    reason       TEXT,
    source       TEXT NOT NULL CHECK (source IN ('llm','manual')),
    prior_label  TEXT,
    prior_source TEXT,
    updated_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labels_partner ON labels(character, partner);
CREATE INDEX IF NOT EXISTS idx_labels_ts ON labels(ts);
"""


def db_path(root: Path | None = None) -> Path:
    base = root or documents.user_data_dir()
    base.mkdir(parents=True, exist_ok=True)
    return base / "labels.db"


def connect(root: Path | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path(root))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def msg_hash(msg: dict) -> str:
    h = hashlib.sha1(f"{msg['ts']}|{msg['speaker']}|{msg['raw']}".encode("utf-8"))
    return h.hexdigest()[:16]


@dataclass(slots=True, frozen=True)
class LabelsSettings:
    threshold_chars: int
    llm_endpoint: str
    llm_model: str
    llm_api_key: str
    system_prompt: str


def _coerce_int(raw: str | None, default: int) -> int:
    if not raw:
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def load_settings(conn: sqlite3.Connection | None = None) -> LabelsSettings:
    """Read all labels-relevant settings, falling back to defaults.

    `conn` is the settings DB connection; if None we open one. Empty
    strings stored in the DB are treated as "unset" and fall back to
    the default — that's how "Reset to default" works from the UI.
    """
    own_conn = False
    if conn is None:
        conn = settings_store.connect()
        own_conn = True
    try:
        threshold_raw = settings_store.get(conn, settings_store.KEY_LABELS_THRESHOLD_CHARS)
        endpoint = settings_store.get(conn, settings_store.KEY_LABELS_LLM_ENDPOINT) or DEFAULT_LLM_ENDPOINT
        model = settings_store.get(conn, settings_store.KEY_LABELS_LLM_MODEL) or DEFAULT_LLM_MODEL
        api_key = settings_store.get(conn, settings_store.KEY_LABELS_LLM_API_KEY) or DEFAULT_LLM_API_KEY
        prompt = settings_store.get(conn, settings_store.KEY_LABELS_SYSTEM_PROMPT) or DEFAULT_SYSTEM_PROMPT
        return LabelsSettings(
            threshold_chars=_coerce_int(threshold_raw, DEFAULT_THRESHOLD_CHARS),
            llm_endpoint=endpoint,
            llm_model=model,
            llm_api_key=api_key,
            system_prompt=prompt,
        )
    finally:
        if own_conn:
            conn.close()


_PARENS_PREFIX = re.compile(r"^\s*\(\(")


def resolve(msg: dict, db_label: sqlite3.Row | dict | None, settings: LabelsSettings) -> str:
    """Return the effective label for a message.

    `db_label` is the explicit-labels row keyed by `msg_hash(msg)`, or
    None. `msg` must have `text` (BBCode-stripped) and `raw` keys —
    matching what `parser.parse_log` yields.
    """
    if db_label is not None:
        # sqlite3.Row supports __getitem__ like a dict
        return db_label["label"]
    text = (msg.get("text") or "").strip()
    if not text:
        return LABEL_OOC
    if len(text) < settings.threshold_chars:
        return LABEL_OOC
    raw = msg.get("raw") or ""
    if _PARENS_PREFIX.match(raw):
        return LABEL_OOC
    return LABEL_UNLABELED


def labels_for_partner(
    conn: sqlite3.Connection,
    character: str,
    partner: str,
) -> dict[str, sqlite3.Row]:
    """All stored labels for one conversation, keyed by message hash.

    Loaded in one query so per-message resolution is a dict lookup —
    a long conversation might have tens of thousands of messages but
    only a few thousand explicit labels.
    """
    rows = conn.execute(
        "SELECT * FROM labels WHERE character = ? AND partner = ?",
        (character, partner),
    ).fetchall()
    return {row["hash"]: row for row in rows}


def upsert_label(
    conn: sqlite3.Connection,
    *,
    hash: str,
    character: str,
    partner: str,
    ts: int,
    speaker: str,
    label: str,
    source: str,
    confidence: float = 1.0,
    reason: str | None = None,
) -> None:
    """Insert or replace a label, snapshotting any prior label.

    `source` is 'llm' or 'manual'. Manual overrides ought to use
    confidence=1.0 — they're the user's verdict, not an estimate.
    """
    if label not in (LABEL_IC, LABEL_OOC):
        raise ValueError(f"invalid label: {label!r}")
    if source not in ("llm", "manual"):
        raise ValueError(f"invalid source: {source!r}")
    existing = conn.execute(
        "SELECT label, source FROM labels WHERE hash = ?", (hash,)
    ).fetchone()
    prior_label = existing["label"] if existing else None
    prior_source = existing["source"] if existing else None
    conn.execute(
        """
        INSERT INTO labels (
            hash, character, partner, ts, speaker, label,
            confidence, reason, source, prior_label, prior_source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(hash) DO UPDATE SET
            label = excluded.label,
            confidence = excluded.confidence,
            reason = excluded.reason,
            source = excluded.source,
            prior_label = excluded.prior_label,
            prior_source = excluded.prior_source,
            updated_at = excluded.updated_at
        """,
        (
            hash, character, partner, ts, speaker, label,
            confidence, reason, source, prior_label, prior_source, time.time(),
        ),
    )
    conn.commit()


def delete_label(conn: sqlite3.Connection, hash: str) -> bool:
    """Remove an explicit label, reverting the message to rule-or-Unlabeled."""
    cur = conn.execute("DELETE FROM labels WHERE hash = ?", (hash,))
    conn.commit()
    return cur.rowcount > 0


def stats(
    conn: sqlite3.Connection,
    character: str,
    partner: str,
    messages: Iterable[dict],
    settings: LabelsSettings,
) -> dict[str, int]:
    """Count IC / OOC / Unlabeled across the supplied messages.

    Caller passes the already-parsed messages (we don't re-walk the
    binary log) plus this conversation's stored labels. Cheap because
    the labels lookup is a single query and resolution is a dict hit
    per message.
    """
    by_hash = labels_for_partner(conn, character, partner)
    counts = {LABEL_IC: 0, LABEL_OOC: 0, LABEL_UNLABELED: 0}
    for msg in messages:
        lab = resolve(msg, by_hash.get(msg_hash(msg)), settings)
        counts[lab] = counts.get(lab, 0) + 1
    return counts
