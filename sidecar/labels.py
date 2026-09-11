"""IC/OOC labels store + read-time resolver.

Persists only **explicit** verdicts — written either by the model the
user connected over MCP or by the user's own right-click override.
Rules are recomputed at every read against the current settings, so
changing the threshold is instant; no DB rebuild needed.

Resolver precedence:
    1. DB label (model or manual)           -> stored row's label
    2. empty body                           -> OOC  (rule:empty)
    3. text_len < settings.threshold_chars  -> OOC  (rule:short)
    4. body starts with "((" (LRP convention) -> OOC (rule:parens)
    5. otherwise                            -> Unlabeled

Case 5 is what `services.classification` hands to the connected model,
and what `chunker` refuses to index.

Storage path: <user_data_dir>/labels.db — its own SQLite file, separate
so users can wipe it without losing their drafts and the ingest job can
safely WAL the file under load.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import paths
import settings as settings_store

# Three-state result the resolver returns. The labels table only ever
# stores IC or OOC; "Unlabeled" is what the resolver returns when no
# explicit label exists and no rule matched — those are the messages
# handed to the connected MCP client to judge.
#
# A fourth state, "Failed", used to exist for messages the in-app
# classifier couldn't get a usable answer about. With no in-app
# classifier there is nothing to fail: a message the model declines to
# label simply stays Unlabeled and comes back in the next batch.
LABEL_IC = "IC"
LABEL_OOC = "OOC"
LABEL_UNLABELED = "Unlabeled"

DEFAULT_THRESHOLD_CHARS = 200

# Classifier prompt, lifted from Chat_RAG/classify.py (German RP).
# Workbench no longer runs a classifier itself; this and the two
# presets below are handed to the connected MCP client through
# `get_classification_guidelines` so its verdicts stay comparable with
# everything labelled before the migration.
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
ist das IC — auch bei alltäglichen Aktivitäten wie Schlafen, Essen, Lesen,
Gehen, Putzen. Die Banalität der Handlung sagt NICHTS über IC vs OOC; die
Perspektive (dritte Person über den Charakter) ist der entscheidende Marker.

DIALOGE: Direkte Rede in Anführungszeichen mit Dialog-Tag (sagte, murmelte, etc.)
ist IC.

MARKER: Der Marker "| action" im Header bedeutet IC, mit zwei Ausnahmen:
(a) Inhalt ist explizit in (…) oder ((…)) Spieler-Klammern, oder
(b) der Text beginnt mit "OOC:" / "//".
Sonst: "| action" + dritte-Person-Selbstnarration = IC, auch ohne Fantasy-Vokabular.

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
- Die Erzählung in DRITTER Person über den Sprecher-Charakter geschieht
  (Indikativ), unabhängig davon wie alltäglich die Handlung ist.
  Beispiel-Heuristik: "Galadriel las ein Buch und ging in die Küche" → IC.
  "Ich hab gestern ein Buch gelesen und bin in die Küche gegangen" → OOC.

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

NACHRICHT: "Éowyn von Rohan verzieht spöttisch den Mund. \\"Dann schlaft ihr
eben in der Scheune, dieses Zimmer nehme ich.\\"
Sie rührt sich nicht, als man sie beiseiteschieben will. \\"Ihr seht mir
ganz nach einer Straßenelfe aus. Packt eure Sachen und verschwindet.\\""
ANTWORT: {"label":"IC","reason":"Sprecher narriert sich selbst in Fantasy-Setting (Scheune, Straßenelfe), IC-Dialog mit Spott"}

NACHRICHT: "[04-15 22:30 | 1240 chars | action] Galadriel: Galadriel hat sich aufs
Bett gelegt, einen Kopfhörer im Ohr, und blättert in ihrem Buch, während ihre
Gedanken auf Reisen gehen. Kurzzeitig versucht sie zu schlafen, gibt es dann aber
auf und widmet sich wieder dem Buch. Sie merkt dass ihr Magen knurrt und verlässt
ihr Zimmer, um die Küche anzusteuern. \\"Sag, gibt es irgendwelche Schränke an die
ich nicht ran darf?\\", fragt sie."
ANTWORT: {"label":"IC","reason":"Dritte-Person-Selbstnarration mit | action-Marker; mundane Aktivitäten zählen trotzdem als IC"}

NACHRICHT: "Zum Beispiel, ja. Wir könnten auch sagen, dass sie sich
in einer Schmugglerkneipe nach Informanten umhört."
ANTWORT: {"label":"OOC","reason":"Plot-Brainstorming: 'Zum Beispiel' + hypothetisches Szenario"}

NACHRICHT: "Kenn ich von meinem alten Job. Bei uns in der Familie war das,
ehrlich gesagt, auch nie anders"
ANTWORT: {"label":"OOC","reason":"Spieler-Anekdote aus echtem Leben (Job, Familie), erste Person"}

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

# English equivalent of the default German prompt. Same heuristics,
# same JSON output contract — keeps users on a non-German chat model
# from having to translate the bundled default themselves.
DEFAULT_SYSTEM_PROMPT_EN = """You are a classifier for English-language F-Chat roleplay logs.
Classify the TARGET MESSAGE strictly as "IC" (in-character) or "OOC" (out-of-character).

IMPORTANT — What is the target message?
The message to classify is ONLY the text between the markers
">>> ZIELNACHRICHT <<<" and ">>> ENDE ZIELNACHRICHT <<<".
The "KONTEXT VORHER" and "KONTEXT NACHHER" blocks are CLUSTER context only —
they are NOT the classification subject. Do NOT quote or use any text from the
context blocks in your reason field.

CORE QUESTION:
Is the described event happening NOW in the game world? (IC) Or are players
talking ABOUT the world, planning, or sharing real-life anecdotes? (OOC)

F-CHAT IC CONVENTIONS (strong IC signals):

SELF-NARRATION: If the SPEAKER (before the colon) uses their OWN character name
as the subject of an action in indicative mood (present/past tense), it is IC —
even for mundane activities like sleeping, eating, reading, walking, cleaning.
The mundanity of the action says NOTHING about IC vs OOC; the perspective
(third person about the character) is the decisive marker.

DIALOGUE: Direct speech in quotation marks with a dialog tag (said, murmured,
etc.) is IC.

MARKER: The "| action" header marker means IC, with two exceptions:
(a) the content is explicitly in (…) or ((…)) player parentheses, or
(b) the text begins with "OOC:" / "//".
Otherwise: "| action" + third-person self-narration = IC, even without fantasy
vocabulary.

FANTASY / SETTING VOCABULARY: setting-specific terms are strong IC signals —
barn, innkeeper, tavern, sword, magic, elf, noblewoman, city guard, carriage,
kingdom, bed, bedside, room (in tavern context), chest, etc. When these appear
the message is ABOUT the game world and almost never a real-life anecdote.

PLOT PLANNING & BRAINSTORMING (OOC):

As soon as the event is hypothetical or being proposed, it is OOC.

Signal words: "for example…", "imagine…", "we could…", "idea:…"

Subjunctive / conditional: "she would / could…" → OOC (not actually happening).

REAL-WORLD ANECDOTES (OOC) — ONLY for IRL topics:

First person ("I", "we") about the player's REAL world: work, profession,
family, IT, crafts, studies, city, illness, politics, weather, school, sports.

NOT a player anecdote (i.e. still IC) when:
- topics come from the game world (barn, elf, innkeeper, sword, noblewoman…)
- one character is speaking to another character — including sarcasm, mockery,
  threats or commentary
- "you / your / this one / that one" refers to a character, not the player
- a sarcastic or ironic statement is made about the in-game situation
- the narration is in THIRD person about the speaker character (indicative),
  no matter how mundane the action.
  Heuristic: "Galadriel read a book and went to the kitchen" → IC.
  "I read a book yesterday and went to the kitchen" → OOC.

DICE / META MESSAGES (OOC):

In F-Chat, player meta-comments are often in (...) parentheses or begin with
"OOC:" / "//". Dice rolls, rule questions, visibility checks ("want to see
the roll?"), away announcements ("brb afk") are OOC.

FORMAT (STRICT):
Respond ONLY with a single JSON object.
NO code fences (no ```json). NO markdown blocks. NO arrays (no [ ]).
NO preamble, no chain-of-thought, NO text before or after the JSON.
The "reason" field MAX 60 characters. Do NOT quote text verbatim and do NOT
use quotation marks in reason — describe the pattern, not the content.
{"label":"IC"|"OOC","reason":"short reason max 60 chars"}"""

# Language-agnostic minimal prompt. Use this when the corpus mixes
# multiple languages or when the chat model is small and tends to
# overfit to the verbose German/English heuristics. Less accurate on
# edge cases but works in any language out of the box.
DEFAULT_SYSTEM_PROMPT_MINIMAL = """Classify the target message between ">>> ZIELNACHRICHT <<<" and ">>> ENDE ZIELNACHRICHT <<<" as either IC (in-character roleplay) or OOC (out-of-character / player chat).

Use the surrounding KONTEXT blocks only as cluster context — they are NOT the classification subject.

Rules of thumb:
- Third-person narration about the speaker's own character, in indicative mood, is IC — even for mundane actions.
- Direct speech in quotation marks with a dialog tag is IC.
- Player parentheses (...), brackets ((...)), explicit "OOC:" / "//" prefixes, dice rolls, and planning ("we could…", "imagine…") are OOC.
- Hypothetical / conditional / subjunctive ("would", "could") about a character is OOC.

Respond with one JSON object, no code fences, no preamble:
{"label":"IC"|"OOC","reason":"short reason, max 60 chars"}"""


@dataclass(slots=True, frozen=True)
class PromptPreset:
    """Bundled classifier prompt the user can drop into Settings → Labels.

    `id` is the stable key the renderer ships back when a preset is
    selected — never displayed to the user. `language` is a coarse hint
    surfaced as a chip ("German", "English", "Any") so non-German users
    can see at a glance why the default isn't classifying their logs.
    """

    id: str
    label: str
    language: str
    description: str
    body: str


# Order matters: the renderer renders them top-to-bottom and the first
# entry is the one whose body matches DEFAULT_SYSTEM_PROMPT — that's
# also the "Reset to default" target.
PROMPT_PRESETS: tuple[PromptPreset, ...] = (
    PromptPreset(
        id="de-default",
        label="German (default)",
        language="German",
        description=(
            "F-Chat-specific heuristics in German. Best for German RP corpora; "
            "verbose so works well with mid-size local models."
        ),
        body=DEFAULT_SYSTEM_PROMPT,
    ),
    PromptPreset(
        id="en-default",
        label="English",
        language="English",
        description=(
            "Same heuristics as the German default, translated. Use this when "
            "your logs are in English or your chat model is English-tuned."
        ),
        body=DEFAULT_SYSTEM_PROMPT_EN,
    ),
    PromptPreset(
        id="minimal",
        label="Language-agnostic (minimal)",
        language="Any",
        description=(
            "Short prompt that works across languages. Less precise on edge "
            "cases than the language-specific presets but fits in tighter "
            "context windows."
        ),
        body=DEFAULT_SYSTEM_PROMPT_MINIMAL,
    ),
)

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
    -- 'mcp': a verdict from the model the user connected over MCP.
    -- 'manual': the user's own right-click override.
    -- 'llm': written by the in-app classifier that existed before the
    -- MCP migration; kept so old rows stay readable.
    source       TEXT NOT NULL CHECK (source IN ('mcp','manual','llm')),
    prior_label  TEXT,
    prior_source TEXT,
    updated_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labels_partner ON labels(character, partner);
CREATE INDEX IF NOT EXISTS idx_labels_ts ON labels(ts);

-- Partner aliases share this DB so every labels.connect() is
-- automatically alias-aware. aliases.py owns the read/write logic;
-- duplicating the CREATE here just guarantees the table exists for
-- callers (rag_jobs, server.py) that pass the labels connection
-- straight into aliases_store helpers.
CREATE TABLE IF NOT EXISTS partner_aliases (
    character     TEXT NOT NULL,
    name          TEXT NOT NULL,
    primary_name  TEXT NOT NULL,
    created_at    REAL NOT NULL,
    PRIMARY KEY (character, name)
);
CREATE INDEX IF NOT EXISTS idx_aliases_primary
    ON partner_aliases(character, primary_name);

"""


def db_path(root: Path | None = None) -> Path:
    base = root or paths.user_data_dir()
    base.mkdir(parents=True, exist_ok=True)
    return base / "labels.db"


def connect(root: Path | None = None) -> sqlite3.Connection:
    # check_same_thread=False — FastAPI runs generator dependencies in
    # the anyio threadpool and may schedule the dep setup, the endpoint
    # body, and the teardown on three different worker threads. SQLite's
    # default same-thread guard then throws cross-thread errors. Per-
    # request open + close means concurrent use of a single connection
    # isn't a risk.
    conn = sqlite3.connect(db_path(root), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _drop_retired_tables(conn)
    _widen_source_check(conn)
    return conn


#: Tables that belonged to the in-app classifier: failed classify
#: attempts, and the history of classify jobs. Nothing writes either
#: since classification moved to the connected MCP client, so they are
#: dropped rather than left to sit in every existing labels.db. The
#: `labels` table itself — the actual verdicts — is untouched.
_RETIRED_TABLES = ("label_failures", "label_jobs")


def _drop_retired_tables(conn: sqlite3.Connection) -> None:
    try:
        for table in _RETIRED_TABLES:
            conn.execute(f"DROP TABLE IF EXISTS {table}")
        conn.commit()
    except sqlite3.DatabaseError:
        # Never let cleanup stop the sidecar from serving labels.
        pass


def _widen_source_check(conn: sqlite3.Connection) -> None:
    """Let existing databases accept `source = 'mcp'`.

    The CHECK constraint predates the MCP migration and only allowed
    'llm' and 'manual', so the first verdict written by a connected
    model would fail with an IntegrityError on any install created
    before this version. SQLite cannot alter a constraint in place, so
    the table is rebuilt — rows and all — the one time it is needed.
    """
    try:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'labels'"
        ).fetchone()
        if row is None or "'mcp'" in (row["sql"] or ""):
            return
        conn.executescript(
            """
            PRAGMA foreign_keys = off;
            BEGIN;
            CREATE TABLE labels_migrated (
                hash         TEXT PRIMARY KEY,
                character    TEXT NOT NULL,
                partner      TEXT NOT NULL,
                ts           INTEGER NOT NULL,
                speaker      TEXT NOT NULL,
                label        TEXT NOT NULL CHECK (label IN ('IC','OOC')),
                confidence   REAL NOT NULL,
                reason       TEXT,
                source       TEXT NOT NULL CHECK (source IN ('mcp','manual','llm')),
                prior_label  TEXT,
                prior_source TEXT,
                updated_at   REAL NOT NULL
            );
            INSERT INTO labels_migrated SELECT
                hash, character, partner, ts, speaker, label, confidence,
                reason, source, prior_label, prior_source, updated_at
            FROM labels;
            DROP TABLE labels;
            ALTER TABLE labels_migrated RENAME TO labels;
            CREATE INDEX IF NOT EXISTS idx_labels_partner
                ON labels(character, partner);
            CREATE INDEX IF NOT EXISTS idx_labels_ts ON labels(ts);
            COMMIT;
            PRAGMA foreign_keys = on;
            """
        )
    except sqlite3.DatabaseError:
        # A failed widening leaves the old table intact: MCP writes will
        # error visibly, which beats losing the user's curated verdicts.
        try:
            conn.rollback()
        except sqlite3.DatabaseError:
            pass


def _publish(event: str, **data) -> None:
    """Announce a label change on the event bus, if one is running.

    Here rather than in the callers so the manual override from the
    log viewer and a model's verdict through MCP both reach the
    window. Never fails a write.
    """
    try:
        from services import events

        events.publish(event, **data)
    except Exception:  # noqa: BLE001
        pass


def msg_hash(msg: dict) -> str:
    h = hashlib.sha1(f"{msg['ts']}|{msg['speaker']}|{msg['raw']}".encode("utf-8"))
    return h.hexdigest()[:16]


@dataclass(slots=True, frozen=True)
class LabelsSettings:
    """What the rule resolver needs. Nothing else survives: the
    classifier's endpoint, model, key, prompt and context window went
    away with the in-app LLM — the connected MCP client decides those
    now (see services/classification.py)."""

    threshold_chars: int


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
        return LabelsSettings(
            threshold_chars=_coerce_int(threshold_raw, DEFAULT_THRESHOLD_CHARS),
        )
    finally:
        if own_conn:
            conn.close()


_PARENS_PREFIX = re.compile(r"^\s*\(\(")


def resolve(
    msg: dict,
    db_label: sqlite3.Row | dict | None,
    settings: LabelsSettings,
) -> str:
    """Return the effective label for a message.

    `db_label` is the explicit-labels row keyed by `msg_hash(msg)`, or
    None. `msg` must have `text` (BBCode-stripped) and `raw` keys —
    matching what `parser.parse_log` yields.

    Precedence: explicit DB label wins; otherwise rules (empty / short /
    `((` prefix) decide; otherwise "Unlabeled".
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
    *,
    partner_aliases: list[str] | None = None,
) -> dict[str, sqlite3.Row]:
    """All stored labels for one conversation, keyed by message hash.

    `partner_aliases` lets the caller fold in labels written under any
    alternate names a partner has been linked to via the aliases
    module. When omitted, only rows with `partner = ?` are returned —
    same behaviour as before aliases existed.

    Loaded in one query so per-message resolution is a dict lookup —
    a long conversation might have tens of thousands of messages but
    only a few thousand explicit labels.
    """
    names = _partner_query_set(partner, partner_aliases)
    placeholders = ",".join("?" * len(names))
    rows = conn.execute(
        f"SELECT * FROM labels WHERE character = ? AND partner IN ({placeholders})",
        (character, *names),
    ).fetchall()
    return {row["hash"]: row for row in rows}


def _partner_query_set(partner: str, alias_names: list[str] | None) -> list[str]:
    """Dedupe the (partner, aliases) tuple → ordered list of names.

    Order doesn't matter for the SQL IN clause but a stable list keeps
    test assertions / cache keys predictable.
    """
    if not alias_names:
        return [partner]
    return sorted({partner, *alias_names})


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

    `source` is 'mcp' (a verdict from the connected model), 'manual'
    (the user's right-click override) or 'llm' (written by the in-app
    classifier that existed before the MCP migration — still accepted
    so old rows round-trip).

    Note: the schema still carries a `confidence REAL NOT NULL` column
    for backwards compatibility with on-disk DBs from earlier versions.
    We always write 1.0 — the model never returned anything informative
    below 0.95 and the field was dropped from the v4 prompt, so the
    column is effectively dead weight. Leaving it in place avoids a
    migration; no callers read it anymore.
    """
    if label not in (LABEL_IC, LABEL_OOC):
        raise ValueError(f"invalid label: {label!r}")
    if source not in ("mcp", "manual", "llm"):
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
    _publish(
        "labels-changed", character=character, partner=partner, hashes=1
    )


def delete_label(conn: sqlite3.Connection, hash: str) -> bool:
    """Remove an explicit label, reverting the message to rule-or-Unlabeled."""
    cur = conn.execute("DELETE FROM labels WHERE hash = ?", (hash,))
    conn.commit()
    if cur.rowcount:
        _publish("labels-changed", hashes=cur.rowcount)
    return cur.rowcount > 0


def delete_labels_for_partner(
    conn: sqlite3.Connection,
    character: str,
    partner: str,
    *,
    partner_aliases: list[str] | None = None,
) -> int:
    """Drop every explicit label for one (character, partner) pair,
    reverting each message to rule-or-Unlabeled. Returns the number of
    rows removed."""
    names = _partner_query_set(partner, partner_aliases)
    placeholders = ",".join("?" * len(names))
    cur = conn.execute(
        f"DELETE FROM labels WHERE character = ? AND partner IN ({placeholders})",
        (character, *names),
    )
    conn.commit()
    _publish(
        "labels-changed",
        character=character,
        partner=partner,
        deleted=cur.rowcount,
    )
    return cur.rowcount


def max_label_time(
    conn: sqlite3.Connection,
    character: str,
    partner: str,
    *,
    partner_aliases: list[str] | None = None,
) -> float | None:
    """Return the most recent labels.updated_at for a partner (or the
    folded alias group), or None when no label rows exist.

    Used to flag stale-label rows in the partner list — compare against
    the log file's mtime to spot conversations that grew since their
    last classify run.
    """
    names = list(partner_aliases) if partner_aliases else [partner]
    if partner not in names:
        names.append(partner)
    placeholders = ",".join("?" * len(names))
    row = conn.execute(
        f"""
        SELECT MAX(updated_at) FROM labels
         WHERE character = ? AND partner IN ({placeholders})
        """,
        (character, *names),
    ).fetchone()
    val = row[0] if row else None
    return float(val) if val is not None else None


def stats(
    conn: sqlite3.Connection,
    character: str,
    partner: str,
    messages: Iterable[dict],
    settings: LabelsSettings,
    *,
    partner_aliases: list[str] | None = None,
) -> dict[str, int]:
    """Count IC / OOC / Unlabeled across the supplied messages.

    Caller passes the already-parsed messages (we don't re-walk the
    binary log) plus this conversation's stored labels. Pass
    `partner_aliases` to fold in label rows written under any linked
    alternate names. Cheap because the labels lookup is a single
    query and resolution is a dict hit per message.
    """
    by_hash = labels_for_partner(
        conn, character, partner, partner_aliases=partner_aliases
    )
    counts = {LABEL_IC: 0, LABEL_OOC: 0, LABEL_UNLABELED: 0}
    for msg in messages:
        lab = resolve(msg, by_hash.get(msg_hash(msg)), settings)
        counts[lab] = counts.get(lab, 0) + 1
    return counts
