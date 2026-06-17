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

Storage path: <user_data_dir>/labels.db — its own SQLite file, separate
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

import paths
import settings as settings_store

# Four-state result the resolver returns. The labels table only ever
# stores IC or OOC; "Unlabeled" is what the resolver returns when no
# explicit label exists and no rule matched; "Failed" surfaces a row
# in the parallel label_failures table — the LLM was asked but didn't
# produce a usable answer (HTTP/JSON/parse error). The user can fix it
# manually from the message context menu; manual overrides clear the
# failure row.
LABEL_IC = "IC"
LABEL_OOC = "OOC"
LABEL_UNLABELED = "Unlabeled"
LABEL_FAILED = "Failed"

DEFAULT_THRESHOLD_CHARS = 200
DEFAULT_LLM_ENDPOINT = "http://localhost:1234/v1"
DEFAULT_LLM_MODEL = "gemma-4-26b-a4b-it-uncensored-heretic"
DEFAULT_LLM_API_KEY = ""
# Default surrounding-context window size for classify calls. RAG_DESIGN
# originally picked 3 + 3; in practice that bleeds — the model latches
# onto the surrounding cluster (e.g. mid-RP banter) and mislabels the
# target. 1 + 1 holds the IC/OOC boundary much better.
#
# WARNING: if you tune this UP and start seeing messages at the *start*
# or *end* of IC/OOC blocks classified wrongly (the target is IC but
# all visible context is OOC, or vice versa), the bleed is back —
# reduce, don't increase. Set to 0 for no surroundings at all when
# debugging the prompt in isolation.
DEFAULT_CONTEXT_BEFORE = 1
DEFAULT_CONTEXT_AFTER = 1

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

NACHRICHT: "Éowyn von Rohan hebt kurz einen Mundwinkel. \\"Nun, dann wünsche
ich euch eine gute Nacht in der Scheune, denn ich werde dieses Zimmer beziehen.\\"
Sie schnauft kurz aus, als sie zur Seite geschoben wird. \\"Aber ihr seid sicher
eine dieser Straßenelfen von denen man hört. Also nehmt eure Sachen und zieht von
dannen.\\""
ANTWORT: {"label":"IC","reason":"Sprecher narriert sich selbst in Fantasy-Setting (Scheune, Straßenelfe), IC-Dialog mit Spott"}

NACHRICHT: "[04-15 22:30 | 1240 chars | action] Galadriel: Galadriel hat sich aufs
Bett gelegt, einen Kopfhörer im Ohr, und blättert in ihrem Buch, während ihre
Gedanken auf Reisen gehen. Kurzzeitig versucht sie zu schlafen, gibt es dann aber
auf und widmet sich wieder dem Buch. Sie merkt dass ihr Magen knurrt und verlässt
ihr Zimmer, um die Küche anzusteuern. \\"Sag, gibt es irgendwelche Schränke an die
ich nicht ran darf?\\", fragt sie."
ANTWORT: {"label":"IC","reason":"Dritte-Person-Selbstnarration mit | action-Marker; mundane Aktivitäten zählen trotzdem als IC"}

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
    source       TEXT NOT NULL CHECK (source IN ('llm','manual')),
    prior_label  TEXT,
    prior_source TEXT,
    updated_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labels_partner ON labels(character, partner);
CREATE INDEX IF NOT EXISTS idx_labels_ts ON labels(ts);

-- Persistent classify-job history. JobRegistry retains in-memory jobs
-- for ~300s; this table survives sidecar restarts so users can see
-- "last classified Auldren Nazr yesterday at 23:14" weeks later.
-- Manual classify runs append on completion; nothing here is
-- consulted by the resolver — purely for UI display.
CREATE TABLE IF NOT EXISTS label_jobs (
    id            TEXT PRIMARY KEY,
    scope         TEXT NOT NULL,    -- JSON: {"character"?: X, "partner"?: Y}
    state         TEXT NOT NULL,    -- 'done' | 'cancelled' | 'failed'
    classified    INTEGER NOT NULL,
    failed        INTEGER NOT NULL,
    total         INTEGER NOT NULL,
    started_at    REAL NOT NULL,
    finished_at   REAL NOT NULL,
    error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_label_jobs_finished
    ON label_jobs(finished_at DESC);

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

-- Parallel to `labels`, but tracks messages whose classify attempt
-- failed (HTTP/JSON/parse error). The resolver returns "Failed" when
-- a hash exists here AND no labels row + no rule hit. Cleared on
-- successful re-classify and on any manual override.
CREATE TABLE IF NOT EXISTS label_failures (
    hash         TEXT PRIMARY KEY,
    character    TEXT NOT NULL,
    partner      TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    speaker      TEXT NOT NULL,
    error        TEXT NOT NULL,
    updated_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_label_failures_partner
    ON label_failures(character, partner);
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


def resolve(
    msg: dict,
    db_label: sqlite3.Row | dict | None,
    settings: LabelsSettings,
    *,
    failed: bool = False,
) -> str:
    """Return the effective label for a message.

    `db_label` is the explicit-labels row keyed by `msg_hash(msg)`, or
    None. `failed` is True when a label_failures row exists for the
    same hash (a prior classify call couldn't produce a usable answer).
    `msg` must have `text` (BBCode-stripped) and `raw` keys — matching
    what `parser.parse_log` yields.

    Precedence: explicit DB label wins; otherwise rules (empty / short /
    `((` prefix) decide; otherwise a recorded failure surfaces as
    "Failed"; otherwise "Unlabeled".
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
    if failed:
        return LABEL_FAILED
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
    # Any explicit label clears a prior failure — the user fixed it
    # (manual override) or a re-classify finally got an answer.
    conn.execute("DELETE FROM label_failures WHERE hash = ?", (hash,))
    conn.commit()


def record_failure(
    conn: sqlite3.Connection,
    *,
    hash: str,
    character: str,
    partner: str,
    ts: int,
    speaker: str,
    error: str,
) -> None:
    """Mark a message as classify-failed.

    No-op if an explicit label already exists for this hash — a
    successful prior classify shouldn't be downgraded to "Failed" just
    because a re-classify attempt errored. The error string is
    truncated; the JSONL log file is the full debug surface.
    """
    has_label = conn.execute(
        "SELECT 1 FROM labels WHERE hash = ?", (hash,)
    ).fetchone()
    if has_label is not None:
        return
    conn.execute(
        """
        INSERT INTO label_failures (
            hash, character, partner, ts, speaker, error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(hash) DO UPDATE SET
            error = excluded.error,
            updated_at = excluded.updated_at
        """,
        (hash, character, partner, ts, speaker, error[:500], time.time()),
    )
    conn.commit()


def clear_failure(conn: sqlite3.Connection, hash: str) -> bool:
    cur = conn.execute("DELETE FROM label_failures WHERE hash = ?", (hash,))
    conn.commit()
    return cur.rowcount > 0


def failures_for_partner(
    conn: sqlite3.Connection,
    character: str,
    partner: str,
    *,
    partner_aliases: list[str] | None = None,
) -> dict[str, sqlite3.Row]:
    """All failure rows for one conversation, keyed by message hash.

    Same alias-aware lookup shape as `labels_for_partner`.
    """
    names = _partner_query_set(partner, partner_aliases)
    placeholders = ",".join("?" * len(names))
    rows = conn.execute(
        f"SELECT * FROM label_failures WHERE character = ? AND partner IN ({placeholders})",
        (character, *names),
    ).fetchall()
    return {row["hash"]: row for row in rows}


def delete_label(conn: sqlite3.Connection, hash: str) -> bool:
    """Remove an explicit label, reverting the message to rule-or-Unlabeled."""
    cur = conn.execute("DELETE FROM labels WHERE hash = ?", (hash,))
    conn.commit()
    return cur.rowcount > 0


def delete_labels_for_partner(
    conn: sqlite3.Connection,
    character: str,
    partner: str,
    *,
    partner_aliases: list[str] | None = None,
) -> int:
    """Drop every explicit label for one (character, partner) pair.

    Also drops any recorded failure rows — "Reset all labels" should
    reset every classifier-side state, not just the success rows.
    Returns the count of deleted label rows (failure rows aren't
    counted; they're an implementation detail of the chip strip).
    """
    names = _partner_query_set(partner, partner_aliases)
    placeholders = ",".join("?" * len(names))
    cur = conn.execute(
        f"DELETE FROM labels WHERE character = ? AND partner IN ({placeholders})",
        (character, *names),
    )
    conn.execute(
        f"DELETE FROM label_failures WHERE character = ? AND partner IN ({placeholders})",
        (character, *names),
    )
    conn.commit()
    return cur.rowcount


def record_job_history(
    conn: sqlite3.Connection,
    *,
    id: str,
    scope: dict,
    state: str,
    classified: int,
    failed: int,
    total: int,
    started_at: float,
    finished_at: float,
    error: str | None,
    keep: int = 200,
) -> None:
    """Persist one finished classify run for the Settings job-history view.

    Inserts the row, then trims to the most recent `keep` entries to
    keep the file bounded — even an aggressive user running 1 classify
    per minute stays under 200 rows for a couple of hours of history,
    which is the use-case the table exists for.
    """
    import json

    conn.execute(
        """
        INSERT OR REPLACE INTO label_jobs
            (id, scope, state, classified, failed, total,
             started_at, finished_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            id,
            json.dumps(scope, sort_keys=True),
            state,
            classified,
            failed,
            total,
            started_at,
            finished_at,
            error,
        ),
    )
    conn.execute(
        """
        DELETE FROM label_jobs
         WHERE id NOT IN (
            SELECT id FROM label_jobs ORDER BY finished_at DESC LIMIT ?
         )
        """,
        (keep,),
    )
    conn.commit()


def list_job_history(
    conn: sqlite3.Connection, *, limit: int = 50
) -> list[dict]:
    """Return the most recent finished classify runs, newest first.

    Each row is the shape the renderer expects on the
    Settings → Labels jobs panel: scope decoded back to a dict,
    timestamps as epoch seconds.
    """
    import json

    rows = conn.execute(
        """
        SELECT id, scope, state, classified, failed, total,
               started_at, finished_at, error
          FROM label_jobs
      ORDER BY finished_at DESC
         LIMIT ?
        """,
        (limit,),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        try:
            scope = json.loads(r[1])
        except (TypeError, ValueError):
            scope = {}
        out.append(
            {
                "id": r[0],
                "scope": scope,
                "state": r[2],
                "classified": r[3],
                "failed": r[4],
                "total": r[5],
                "started_at": r[6],
                "finished_at": r[7],
                "error": r[8],
            }
        )
    return out


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
    failed_hashes = failures_for_partner(
        conn, character, partner, partner_aliases=partner_aliases
    )
    counts = {LABEL_IC: 0, LABEL_OOC: 0, LABEL_UNLABELED: 0, LABEL_FAILED: 0}
    for msg in messages:
        h = msg_hash(msg)
        lab = resolve(
            msg, by_hash.get(h), settings, failed=h in failed_hashes,
        )
        counts[lab] = counts.get(lab, 0) + 1
    return counts
