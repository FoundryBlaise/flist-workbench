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
# Default surrounding-context window size for classify calls. 3 + 3
# is the value RAG_DESIGN.md picked; users can tune down (small VRAM)
# or up via Settings → Labels.
DEFAULT_CONTEXT_BEFORE = 3
DEFAULT_CONTEXT_AFTER = 3

# Default classifier prompt. Lifted from Chat_RAG/classify.py (German
# RP). Users can edit this in Settings → Labels; a blank stored value
# falls back to this default, so "reset to default" is just "save blank".
DEFAULT_SYSTEM_PROMPT = """Du bist ein Klassifikator für deutschsprachige Roleplay-Chat-Logs aus F-Chat.
Klassifiziere die ZIELNACHRICHT zwingend als "IC" (in-character) oder "OOC" (out-of-character).

WICHTIG — Was ist die Zielnachricht?
Die zu klassifizierende Nachricht steht AUSSCHLIESSLICH zwischen den Markierungen
">>> ZIELNACHRICHT <<<" und ">>> ENDE ZIELNACHRICHT <<<".
Inhalt aus den Blöcken "KONTEXT VORHER" oder "KONTEXT NACHHER" dient NUR als
Cluster-Information — er ist NICHT der Klassifikationsgegenstand. Zitiere oder
verwende keinen Text aus den Kontextblöcken in deinem Reason-Feld.

KERNFRAGE FÜR DIE KLASSIFIZIERUNG:
Passiert das Beschriebene JETZT in der Spielwelt? (IC) Oder reden Spieler ÜBER die
Welt, planen, oder erzählen aus dem echten Leben? (OOC)

F-CHAT IC-KONVENTIONEN (Starke IC-Signale):

SELBSTNARRATION: Wenn der SPRECHER (vor dem Doppelpunkt) seinen EIGENEN
Charakternamen als Subjekt einer Handlung nutzt (Indikativ, Präsens/Präteritum),
ist das IC.

DIALOGE: Direkte Rede in Anführungszeichen mit Dialog-Tag (sagte, murmelte, etc.)
ist IC.

MARKER: Der Marker "| action" im Header bedeutet fast immer IC.

FANTASY/SETTING-VOKABULAR: Setting-spezifische Begriffe sind starke IC-Signale —
Scheune, Wirt, Wirtshaus, Schwert, Magie, Elf/Elfin, Adelsdame, Stadtwache,
Kutsche, Tavernen, Königreich, Bett, Bettkante, Zimmer (im Wirtshaus-Kontext),
Truhe etc. Wenn solche Begriffe vorkommen, ist die Nachricht ÜBER die Spielwelt
und damit fast nie eine Real-Life-Anekdote.

PLOT-PLANUNG & BRAINSTORMING (OOC):

Sobald das Geschehen hypothetisch ist oder vorgeschlagen wird, ist es OOC.

Signalwörter: "Zum Beispiel...", "Stell dir vor...", "Wir könnten...", "Idee:..."

Nutzung des Konjunktivs: "Sie würde / könnte..." -> OOC (da nicht real geschehend).

REALE WELT-ANEKDOTEN (OOC) — NUR bei IRL-Themen:

Erste Person ("ich", "wir") über die ECHTE Welt des Spielers: Arbeit, Beruf,
Familie, IT, Handwerk, Studium, Stadt, Krankheit, Politik, Wetter, Schule,
Sport.

KEINE Spieler-Anekdote (sondern IC), wenn:
- Themen aus der Spielwelt stammen (Scheune, Elf, Wirt, Schwert, Adelsdame…)
- Ein Charakter zu einem anderen Charakter spricht — auch sarkastisch, spöttisch,
  drohend oder kommentierend
- "Du / Ihr / dieser / jene" auf einen Charakter zeigt, nicht auf den Spieler
- Eine sarkastische oder ironische Aussage zur Spielsituation gemacht wird

WÜRFEL- / META-NACHRICHTEN (OOC):

In F-Chat sind Spieler-Meta-Kommentare oft in (...) Klammern oder beginnen mit
"OOC:" / "//". Würfelwürfe, Regelfragen, Sichtbarkeits-Absprachen ("willst du den
Wurf sehen?"), Pausenansagen ("kurz AFK") sind OOC.

BEISPIELE ZUR MUSTERERKENNUNG:

NACHRICHT: "Galadriel legte sanft ihre seidige Hand auf das kühle Metall des
Türgriffs und zog die Tür langsam auf."
ANTWORT: {"label":"IC","reason":"Szenenerzählung in dritter Person, passiert jetzt"}

NACHRICHT: "[03-12 21:08 | 92 chars] Yennefer: Yennefer kommt durch die Tür,
trägt einen langen Mantel und schaut sich suchend um."
ANTWORT: {"label":"IC","reason":"Sprecher Yennefer beschreibt sich selbst in dritter Person"}

NACHRICHT: "\\"Das ist eine wirklich schlechte Idee\\", murmelte sie und schüttelte
den Kopf, ohne ihn anzusehen."
ANTWORT: {"label":"IC","reason":"Direkte Rede in Anführungszeichen + Dialogtag + Begleitaktion"}

NACHRICHT: "Éowyn von Rohan hebt kurz einen Mundwinkel. \\"Nun, dann wünsche
ich euch eine gute Nacht in der Scheune, denn ich werde dieses Zimmer beziehen.\\"
Sie schnauft kurz aus, als sie zur Seite geschoben wird. \\"Aber ihr seid sicher
eine dieser Straßenelfen von denen man hört. Also nehmt eure Sachen und zieht von
dannen.\\""
ANTWORT: {"label":"IC","reason":"Sprecher narriert sich selbst in Fantasy-Setting (Scheune, Straßenelfe), IC-Dialog mit Spott"}

NACHRICHT: "Zum Beispiel, ja. Denke so spontan daran dass sie in einem
Untergrundtreff rumtreibt um Kontakte zu knüpfen."
ANTWORT: {"label":"OOC","reason":"Plot-Brainstorming: 'Zum Beispiel' + hypothetisches Szenario"}

NACHRICHT: "Ich hab es in der IT oft mitgekriegt. Komm aus ner Handwerker Familie,
kann mir also vorstellen wie das ist"
ANTWORT: {"label":"OOC","reason":"Spieler-Anekdote aus echtem Leben (IT, Handwerker), erste Person"}

NACHRICHT: "Sie würde ihn vielleicht erst mal mustern, bevor sie etwas sagt."
ANTWORT: {"label":"OOC","reason":"Konjunktiv 'würde' beschreibt Möglichkeit, nicht Geschehen"}

NACHRICHT: "(Ich werde jetzt würfeln für den Magieffekt. Willst du den Wurf sehen
oder soll ich das eher heimlich machen?)"
ANTWORT: {"label":"OOC","reason":"Spieler-Absprache zu Würfelwurf in (…) Klammern"}

FORMAT (STRIKTE PFLICHT):
Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt.
KEINE Code-Fences (kein ```json). KEINE Markdown-Blöcke. KEINE Arrays (kein [ ]).
KEINE Vor-Überlegung, kein Chain-of-Thought, KEIN Text vor oder nach dem JSON.
Das "reason"-Feld MAX 60 Zeichen. Verwende KEINE wörtlichen Zitate aus dem Text
und KEINE Anführungszeichen im Reason — beschreibe das Muster, nicht den Inhalt.
{"label":"IC"|"OOC","reason":"kurze Begründung max 60 Zeichen"}"""

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
    context_before: int
    context_after: int


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
        ctx_before_raw = settings_store.get(conn, settings_store.KEY_LABELS_CONTEXT_BEFORE)
        ctx_after_raw = settings_store.get(conn, settings_store.KEY_LABELS_CONTEXT_AFTER)
        return LabelsSettings(
            threshold_chars=_coerce_int(threshold_raw, DEFAULT_THRESHOLD_CHARS),
            llm_endpoint=endpoint,
            llm_model=model,
            llm_api_key=api_key,
            system_prompt=prompt,
            # Clamp to a sane range — context that's too wide blows the
            # model's window; negative or zero is fine (no surroundings).
            context_before=max(0, min(10, _coerce_int(ctx_before_raw, DEFAULT_CONTEXT_BEFORE))),
            context_after=max(0, min(10, _coerce_int(ctx_after_raw, DEFAULT_CONTEXT_AFTER))),
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
    reason: str | None = None,
) -> None:
    """Insert or replace a label, snapshotting any prior label.

    `source` is 'llm' or 'manual'.

    Note: the schema still carries a `confidence REAL NOT NULL` column
    for backwards compatibility with on-disk DBs from earlier versions.
    We always write 1.0 — the model never returned anything informative
    below 0.95 and the field was dropped from the v4 prompt, so the
    column is effectively dead weight. Leaving it in place avoids a
    migration; no callers read it anymore.
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
            1.0, reason, source, prior_label, prior_source, time.time(),
        ),
    )
    conn.commit()


def delete_label(conn: sqlite3.Connection, hash: str) -> bool:
    """Remove an explicit label, reverting the message to rule-or-Unlabeled."""
    cur = conn.execute("DELETE FROM labels WHERE hash = ?", (hash,))
    conn.commit()
    return cur.rowcount > 0


def delete_labels_for_partner(
    conn: sqlite3.Connection, character: str, partner: str
) -> int:
    """Drop every explicit label for one (character, partner) pair.

    Returns the count of deleted rows. After this call, every message
    in the conversation falls back to the rule-on-read resolver — so
    rule:short / rule:parens / rule:empty hits stay OOC, everything
    else reverts to Unlabeled.
    """
    cur = conn.execute(
        "DELETE FROM labels WHERE character = ? AND partner = ?",
        (character, partner),
    )
    conn.commit()
    return cur.rowcount


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
