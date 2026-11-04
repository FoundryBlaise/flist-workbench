"""IC/OOC labels store + read-time resolver.

Persists only **explicit** verdicts — written either by the model the
user connected over MCP or by the user's own right-click override.
Rules are recomputed at every read against the current settings, so
changing the threshold is instant; no DB rebuild needed.

Resolver precedence:
    1. system line (ad, roll, warn, event)  -> no Label (None)
    2. DB label (model or manual)           -> stored row's label
    3. empty body                           -> OOC  (rule:empty)
    4. text_len < settings.threshold_chars  -> OOC  (rule:short)
    5. body starts with "((" (LRP convention) -> OOC (rule:parens)
    6. otherwise                            -> Unlabeled

`text_len` is what the user wrote: a `/me` action is measured without
the speaker name the parser puts in front.

Case 6 is what `services.classification` hands to the connected model,
and what `chunker` refuses to index. Case 1 is in none of the counts,
batches or chunks: a Label is a verdict on a message a person wrote.

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
from typing import Iterable, Iterator

import paths
import settings as settings_store
import sqlite_db
from services import events

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
# `get_labelling_guidelines` so its Labels stay comparable with
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
Der Sprechername muss NICHT der erzählte Charakter sein — Spieler führen oft
mehrere Figuren unter einem Account. Dritte-Person-Narration über IRGENDEINE
Figur ist IC.

UMGEBUNGS- / SZENEN-NARRATION: Ein Sprecher darf auch Umgebung, NPCs und
Ereignisse erzählen, ohne den eigenen Charakter zu nennen. Beschreibt der Text,
was in der Spielwelt geschieht oder was das Gegenüber dort vorfindet, ist es IC
— auch ohne eigenen Charakternamen als Subjekt.

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

KONJUNKTIV ALLEIN ENTSCHEIDET NICHT. Die Frage ist: Wird dem MITSPIELER etwas
vorgeschlagen, oder wird der SPIELWELT etwas erzählt?
- Vorschlag an den Mitspieler ("wir könnten...", "sie würde dann vielleicht ...
  was meinst du?") -> OOC
- Erzählte Handlung, die dem Gegenüber Reaktionsraum lässt ("Sie würde die Tür
  öffnen und eintreten", "Sollte er sich umdrehen, sieht er...") -> IC. Das ist
  in F-Chat die übliche Höflichkeitsform, kein Vorschlag.

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

GEMISCHTE NACHRICHTEN:

Enthält eine Nachricht IC-Erzählung UND einen Spieler-Einschub in (…),
entscheidet der Hauptteil. Ein angehängter Klammerkommentar macht einen
IC-Post nicht zu OOC.

BEISPIELE ZUR MUSTERERKENNUNG:

NACHRICHT: "Galadriel legte sanft ihre seidige Hand auf das kühle Metall des
Türgriffs und zog die Tür langsam auf."
URTEIL: {"label":"IC","reason":"Szenenerzählung in dritter Person, passiert jetzt"}

NACHRICHT: "[03-12 21:08 | 92 chars] Yennefer: Yennefer kommt durch die Tür,
trägt einen langen Mantel und schaut sich suchend um."
URTEIL: {"label":"IC","reason":"Sprecher Yennefer beschreibt sich selbst in dritter Person"}

NACHRICHT: "\\"Das ist eine wirklich schlechte Idee\\", murmelte sie und schüttelte
den Kopf, ohne ihn anzusehen."
URTEIL: {"label":"IC","reason":"Direkte Rede in Anführungszeichen + Dialogtag + Begleitaktion"}

NACHRICHT: "Éowyn von Rohan verzieht spöttisch den Mund. \\"Dann schlaft ihr
eben in der Scheune, dieses Zimmer nehme ich.\\"
Sie rührt sich nicht, als man sie beiseiteschieben will. \\"Ihr seht mir
ganz nach einer Straßenelfe aus. Packt eure Sachen und verschwindet.\\""
URTEIL: {"label":"IC","reason":"Sprecher narriert sich selbst in Fantasy-Setting (Scheune, Straßenelfe), IC-Dialog mit Spott"}

NACHRICHT: "[04-15 22:30 | 1240 chars | action] Galadriel: Galadriel hat sich aufs
Bett gelegt, einen Kopfhörer im Ohr, und blättert in ihrem Buch, während ihre
Gedanken auf Reisen gehen. Kurzzeitig versucht sie zu schlafen, gibt es dann aber
auf und widmet sich wieder dem Buch. Sie merkt dass ihr Magen knurrt und verlässt
ihr Zimmer, um die Küche anzusteuern. \\"Sag, gibt es irgendwelche Schränke an die
ich nicht ran darf?\\", fragt sie."
URTEIL: {"label":"IC","reason":"Dritte-Person-Selbstnarration mit | action-Marker; mundane Aktivitäten zählen trotzdem als IC"}

NACHRICHT: "Zum Beispiel, ja. Wir könnten auch sagen, dass sie sich
in einer Schmugglerkneipe nach Informanten umhört."
URTEIL: {"label":"OOC","reason":"Plot-Brainstorming: 'Zum Beispiel' + hypothetisches Szenario"}

NACHRICHT: "Kenn ich von meinem alten Job. Bei uns in der Familie war das,
ehrlich gesagt, auch nie anders"
URTEIL: {"label":"OOC","reason":"Spieler-Anekdote aus echtem Leben (Job, Familie), erste Person"}

NACHRICHT: "Sie würde ihn vielleicht erst mal mustern, bevor sie etwas sagt.
Wäre das so okay für dich?"
URTEIL: {"label":"OOC","reason":"Vorschlag an den Mitspieler, nicht erzählte Handlung"}

NACHRICHT: "Sie würde den Rest des Tages nicht mehr stören. Sollte Amber die Tür
öffnen, findet sie eine Flasche Wasser und zwei Kekse davor."
URTEIL: {"label":"IC","reason":"Erzählte Handlung im Konjunktiv, kein Vorschlag"}

NACHRICHT: "[08-31 09:32 | 3735 chars | action] Asmira: Am nächsten Morgen
wartet ein Wagen vor dem Tor. Auf der Rückbank liegt ein versiegelter Umschlag,
daneben eine Karte mit dem Ziel der Reise."
URTEIL: {"label":"IC","reason":"Szenen- und Umgebungsnarration ohne eigenen Charakternamen"}

NACHRICHT: "(Ich werde jetzt würfeln für den Magieffekt. Willst du den Wurf sehen
oder soll ich das eher heimlich machen?)"
URTEIL: {"label":"OOC","reason":"Spieler-Absprache zu Würfelwurf in (…) Klammern"}

FORMAT:
Gib die Urteile über das Tool `set_message_labels` zurück — ein Eintrag pro
Nachricht: {"hash": ..., "label": "IC"|"OOC", "reason": ...}.
Der Hash muss exakt der aus `get_unlabeled_messages` sein; ein falscher
Hash beschriftet eine fremde Nachricht.
Beurteile jede Nachricht des Batches, lass keine aus.

Nachdenken vor dem Tool-Aufruf ist erlaubt und erwünscht — es landet nicht in
den Daten. Gespeichert wird nur `reason`: MAX 60 Zeichen, KEINE wörtlichen
Zitate aus dem Text und KEINE Anführungszeichen — beschreibe das Muster,
nicht den Inhalt."""

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
The speaker name need NOT be the narrated character — players often run several
figures from one account. Third-person narration about ANY figure is IC.

SCENE / ENVIRONMENT NARRATION: a speaker may also narrate surroundings, NPCs and
events without naming their own character. If the text describes what happens in
the game world, or what the other character finds there, it is IC — even with no
own character name as the subject.

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

SUBJUNCTIVE ALONE DOES NOT DECIDE. The question is: is something being proposed
to the PLAYER, or narrated to the GAME WORLD?
- a proposal to the other player ("we could…", "she would maybe … what do you
  think?") → OOC
- a narrated action that leaves the other side room to react ("She would open the
  door and step inside", "Should he turn around, he sees…") → IC. In F-Chat this
  is the customary polite form, not a proposal.

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

MIXED MESSAGES:

When a message contains IC narration AND a player aside in (…), the main body
decides. A trailing parenthetical does not turn an IC post into OOC.

FORMAT:
Return the verdicts through the `set_message_labels` tool — one entry per
message: {"hash": ..., "label": "IC"|"OOC", "reason": ...}.
The hash must be exactly the one from `get_unlabeled_messages`; a wrong
hash labels someone else's message.
Judge every message in the batch, skip none.

Thinking before the tool call is allowed and welcome — it does not reach the
data. Only `reason` is stored: MAX 60 characters, no verbatim quotes from the
text and no quotation marks — describe the pattern, not the content."""

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
- Conditional / subjunctive alone does not decide: a proposal to the other PLAYER ("we could…", "what do you think?") is OOC, but a narrated action phrased politely ("She would open the door", "Should he look, he sees…") is IC.
- Narration of surroundings, NPCs or events without the speaker's own character name is still IC.
- One account may voice several characters; third-person narration about any of them is IC.

Return verdicts through the `set_message_labels` tool: one entry per message,
{"hash": ..., "label": "IC"|"OOC", "reason": ...}, reusing the hash exactly as
given. Think first if it helps; only `reason` is stored, max 60 chars, no
verbatim quotes."""


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

# labels.db holds more than Labels: the partner aliases (aliases.py),
# the Index manifest (rag_store.py) and the keyword index
# (rag_lexical.py) live in the same file. Its whole schema is created
# and migrated here, so every connection to the file, whichever module
# opens it, gets the same version, WAL and busy timeout.
#
# Released steps never change; a schema change is a new step at the end.


def _create_tables(conn: sqlite3.Connection) -> None:
    """The schema as of the first versioned release.

    Every statement is IF NOT EXISTS: an unversioned database from an
    earlier release already has most of these tables, in shapes the
    following steps bring up to date.
    """
    for statement in (
        """
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
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_labels_partner ON labels(character, partner)",
        "CREATE INDEX IF NOT EXISTS idx_labels_ts ON labels(ts)",
        """
        CREATE TABLE IF NOT EXISTS partner_aliases (
            character     TEXT NOT NULL,
            name          TEXT NOT NULL,
            primary_name  TEXT NOT NULL,
            created_at    REAL NOT NULL,
            PRIMARY KEY (character, name)
        )
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_aliases_primary
            ON partner_aliases(character, primary_name)
        """,
        # The Index manifest: embedding model, dimension, last ingest.
        """
        CREATE TABLE IF NOT EXISTS rag_meta (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL,
            updated_at  REAL NOT NULL
        )
        """,
        # The keyword index, mirroring the Index's chunk text.
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
            chunk_id    UNINDEXED,
            char_owner  UNINDEXED,
            partner     UNINDEXED,
            text,
            tokenize='unicode61 remove_diacritics 2'
        )
        """,
    ):
        conn.execute(statement)


#: Tables that belonged to the in-app classifier: failed classify
#: attempts, and the history of classify jobs. Nothing writes either
#: since classification moved to the connected MCP client, so they are
#: dropped rather than left to sit in every existing labels.db. The
#: `labels` table itself — the actual verdicts — is untouched.
_drop_retired_tables = sqlite_db.statements(
    "DROP TABLE IF EXISTS label_failures",
    "DROP TABLE IF EXISTS label_jobs",
)


def _widen_source_check(conn: sqlite3.Connection) -> None:
    """Let databases from before the MCP migration accept `source = 'mcp'`.

    The CHECK constraint used to allow only 'llm' and 'manual', so the
    first verdict written by a connected model would fail with an
    IntegrityError. SQLite cannot alter a constraint in place, so the
    table is rebuilt, rows and all.
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'labels'"
    ).fetchone()
    if row is None or "'mcp'" in (row["sql"] or ""):
        return
    for statement in (
        """
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
        )
        """,
        """
        INSERT INTO labels_migrated SELECT
            hash, character, partner, ts, speaker, label, confidence,
            reason, source, prior_label, prior_source, updated_at
        FROM labels
        """,
        "DROP TABLE labels",
        "ALTER TABLE labels_migrated RENAME TO labels",
        "CREATE INDEX IF NOT EXISTS idx_labels_partner ON labels(character, partner)",
        "CREATE INDEX IF NOT EXISTS idx_labels_ts ON labels(ts)",
    ):
        conn.execute(statement)


def _drop_label_owner(conn: sqlite3.Connection) -> None:
    """A Label belongs to the message (ADR 0004), so the character and
    partner each row stored, and their index, go.

    Should a database ever hold more than one verdict for a message,
    one is kept: a manual Label over a model's, and within the same
    kind the newer one. Every kept row keeps its verdict, source and
    prior Label.
    """
    for statement in (
        """
        CREATE TABLE labels_migrated (
            hash         TEXT PRIMARY KEY,
            ts           INTEGER NOT NULL,
            speaker      TEXT NOT NULL,
            label        TEXT NOT NULL CHECK (label IN ('IC','OOC')),
            confidence   REAL NOT NULL,
            reason       TEXT,
            source       TEXT NOT NULL CHECK (source IN ('mcp','manual','llm')),
            prior_label  TEXT,
            prior_source TEXT,
            updated_at   REAL NOT NULL
        )
        """,
        """
        INSERT INTO labels_migrated
        SELECT hash, ts, speaker, label, confidence, reason, source,
               prior_label, prior_source, updated_at
        FROM (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY hash
                ORDER BY source = 'manual' DESC, updated_at DESC
            ) AS pick
            FROM labels
        )
        WHERE pick = 1
        """,
        "DROP TABLE labels",
        "ALTER TABLE labels_migrated RENAME TO labels",
        "CREATE INDEX IF NOT EXISTS idx_labels_ts ON labels(ts)",
    ):
        conn.execute(statement)


MIGRATIONS: tuple[sqlite_db.Migration, ...] = (
    _create_tables,
    _drop_retired_tables,
    _widen_source_check,
    _drop_label_owner,
)

#: The `user_version` of a labels.db that has every migration.
SCHEMA_VERSION = len(MIGRATIONS)


def db_path(root: Path | None = None) -> Path:
    base = root or paths.user_data_dir()
    base.mkdir(parents=True, exist_ok=True)
    return base / "labels.db"


def connect(root: Path | None = None) -> sqlite3.Connection:
    """Open labels.db, migrated to the latest version (see sqlite_db)."""
    return sqlite_db.connect(db_path(root), MIGRATIONS)


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


def _written_text(msg: dict) -> str:
    """What the user wrote, as the short-message rule measures it.

    The parser puts the speaker's name in front of a `/me` action so it
    reads naturally; that name is not part of what the user typed, so a
    long name must not reach the threshold earlier (decided on #5).
    """
    text = (msg.get("text") or "").strip()
    if msg.get("type_name") == "action":
        prefix = f"{msg.get('speaker') or ''} "
        if text.startswith(prefix):
            text = text[len(prefix):].strip()
    return text


def is_system_line(msg: dict) -> bool:
    """An ad, roll, warning or status event: F-Chat wrote it, not a
    person, so it never gets a Label."""
    return msg.get("kind") == "system"


def resolve(
    msg: dict,
    db_label: sqlite3.Row | dict | None,
    settings: LabelsSettings,
) -> str | None:
    """Return the effective label for a message, None for a system line.

    `db_label` is the explicit-labels row keyed by `msg_hash(msg)`, or
    None. `msg` must have `text` (BBCode-stripped) and `raw` keys —
    matching what `parser.parse_log` yields.

    Precedence: a system line (ad, roll, warning, status event) has no
    Label before anything else, because a Label is a verdict on a
    message a person wrote; then an explicit DB label wins; otherwise
    rules (empty / short / `((` prefix) decide; otherwise "Unlabeled".
    """
    if is_system_line(msg):
        return None
    if db_label is not None:
        # sqlite3.Row supports __getitem__ like a dict
        return db_label["label"]
    text = _written_text(msg)
    if not text:
        return LABEL_OOC
    if len(text) < settings.threshold_chars:
        return LABEL_OOC
    raw = msg.get("raw") or ""
    if _PARENS_PREFIX.match(raw):
        return LABEL_OOC
    return LABEL_UNLABELED


#: Hashes per `IN (...)` query, under SQLite's bound-parameter limit.
_HASH_BATCH = 500


def _hash_batches(hashes: Iterable[str]) -> Iterator[tuple[list[str], str]]:
    """`hashes`, without blanks and repeats, in batches of at most
    `_HASH_BATCH`, each with its `?,?,...` placeholders."""
    ids = list(dict.fromkeys(h for h in hashes if h))
    for start in range(0, len(ids), _HASH_BATCH):
        batch = ids[start : start + _HASH_BATCH]
        yield batch, ",".join("?" * len(batch))


def _rows_for_hashes(
    conn: sqlite3.Connection, columns: str, hashes: Iterable[str]
) -> Iterator[sqlite3.Row]:
    for batch, placeholders in _hash_batches(hashes):
        yield from conn.execute(
            f"SELECT {columns} FROM labels WHERE hash IN ({placeholders})", batch
        )


def labels_for_messages(
    conn: sqlite3.Connection, messages: Iterable[dict]
) -> dict[str, sqlite3.Row]:
    """The stored Labels of `messages`, keyed by message hash.

    A Label belongs to the message (ADR 0004), so a conversation's
    Labels are the Labels of the messages its Log holds, whichever
    character or partner wrote them: pass the conversation's messages
    (its whole alias group, as `logs.read_messages` reads it).
    """
    return {
        row["hash"]: row
        for row in _rows_for_hashes(conn, "*", (msg_hash(m) for m in messages))
    }


def upsert_label(
    conn: sqlite3.Connection,
    *,
    hash: str,
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
    from earlier versions. We always write 1.0 and nothing reads it.
    The rebuild that dropped the owner columns kept it, because Label
    rows in the Trash (`LABEL_COLUMNS`) carry it and restore as they
    are.
    """
    upsert_verdicts(conn, [(hash, ts, speaker, label, reason)], source=source)


def upsert_labels_many(
    conn: sqlite3.Connection,
    items: Iterable[tuple[str, int, str]],
    *,
    label: str,
    source: str = "manual",
    reason: str | None = "manual override",
) -> int:
    """`upsert_label` for a batch of `(hash, ts, speaker)`, in one
    transaction and one `labels-changed` event. For the log view's
    multi-select: the user picks rows scattered through a conversation
    and gives them all the same verdict. Each row still keeps its own
    prior label for the badge tooltip."""
    return upsert_verdicts(
        conn,
        [(h, ts, speaker, label, reason) for h, ts, speaker in items],
        source=source,
    )


def upsert_verdicts(
    conn: sqlite3.Connection,
    items: Iterable[tuple[str, int, str, str, str | None]],
    *,
    source: str,
) -> int:
    """Store `(hash, ts, speaker, label, reason)` verdicts, each with its
    own label and reason, in one transaction and one `labels-changed`
    event. Every row snapshots the label it replaces as its prior one.
    A manual Label is only ever replaced by another manual one: a
    write from any other source leaves it untouched (callers that
    report skips find them first with `manual_hashes`).
    Returns how many messages were written."""
    if source not in ("mcp", "manual", "llm"):
        raise ValueError(f"invalid source: {source!r}")
    # One row per hash, the last mention winning, so a doubled entry
    # cannot snapshot its own new label as the prior one.
    rows: dict[str, tuple[int, str, str, str | None]] = {}
    for h, ts, speaker, label, reason in items:
        if label not in (LABEL_IC, LABEL_OOC):
            raise ValueError(f"invalid label: {label!r}")
        if h:
            rows[h] = (ts, speaker, label, reason)
    if not rows:
        return 0
    prior = {
        r["hash"]: (r["label"], r["source"])
        for r in _rows_for_hashes(conn, "hash, label, source", rows)
    }
    now = time.time()
    conn.executemany(
        """
        INSERT INTO labels (
            hash, ts, speaker, label,
            confidence, reason, source, prior_label, prior_source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(hash) DO UPDATE SET
            label = excluded.label,
            confidence = excluded.confidence,
            reason = excluded.reason,
            source = excluded.source,
            prior_label = excluded.prior_label,
            prior_source = excluded.prior_source,
            updated_at = excluded.updated_at
        WHERE labels.source != 'manual' OR excluded.source = 'manual'
        """,
        [
            (h, ts, speaker, label, 1.0, reason, source, *prior.get(h, (None, None)), now)
            for h, (ts, speaker, label, reason) in rows.items()
        ],
    )
    conn.commit()
    events.publish(events.LABELS_CHANGED, hashes=len(rows))
    return len(rows)


def label_row(conn: sqlite3.Connection, hash: str) -> dict | None:
    """The stored Label of one message as a dict of `LABEL_COLUMNS`, or
    None when it has none."""
    row = conn.execute(
        f"SELECT {', '.join(LABEL_COLUMNS)} FROM labels WHERE hash = ?", (hash,)
    ).fetchone()
    return dict(row) if row is not None else None


def manual_hashes(conn: sqlite3.Connection, hashes: Iterable[str]) -> set[str]:
    """Which of `hashes` carry a Label the user set by hand. Only the
    window changes those; `upsert_verdicts` from any other source
    leaves them as they are."""
    return {
        r["hash"]
        for r in _rows_for_hashes(conn, "hash, source", hashes)
        if r["source"] == "manual"
    }


def count_by_source(conn: sqlite3.Connection, source: str) -> int:
    """How many stored Labels came from `source` ('manual', 'mcp', 'llm')."""
    row = conn.execute(
        "SELECT COUNT(*) FROM labels WHERE source = ?", (source,)
    ).fetchone()
    return int(row[0] or 0)


def delete_label(conn: sqlite3.Connection, hash: str) -> bool:
    """Remove an explicit label, reverting the message to rule-or-Unlabeled."""
    cur = conn.execute("DELETE FROM labels WHERE hash = ?", (hash,))
    conn.commit()
    if cur.rowcount:
        events.publish(events.LABELS_CHANGED, hashes=cur.rowcount)
    return cur.rowcount > 0


#: Every column of a stored Label, in the order the Trash keeps them.
#: Trash entries from before the owner columns were dropped also carry
#: `character` and `partner`; putting them back ignores both.
LABEL_COLUMNS = (
    "hash", "ts", "speaker", "label",
    "confidence", "reason", "source", "prior_label", "prior_source",
    "updated_at",
)


def label_rows(
    conn: sqlite3.Connection, messages: Iterable[dict] | None = None
) -> list[dict]:
    """The stored Labels of `messages` (one conversation's Log, or
    every Log of a character), or every stored Label when `messages` is
    None, as plain dicts of `LABEL_COLUMNS` in time order. What clearing
    them would take away, so it can go to the Trash first."""
    cols = ", ".join(LABEL_COLUMNS)
    if messages is None:
        return [dict(r) for r in conn.execute(f"SELECT {cols} FROM labels ORDER BY ts")]
    rows = [dict(r) for r in _rows_for_hashes(conn, cols, (msg_hash(m) for m in messages))]
    rows.sort(key=lambda r: (r["ts"], r["hash"]))
    return rows


def restore_labels(
    conn: sqlite3.Connection, rows: Iterable[dict]
) -> tuple[int, list[str]]:
    """Put Labels back as the Trash kept them. A message that holds a
    Label again has a newer verdict than the kept one, so it keeps it:
    its hash is returned as skipped. Returns (restored, skipped)."""
    wanted = {r["hash"]: r for r in rows if r.get("hash")}
    present = {r["hash"] for r in _rows_for_hashes(conn, "hash", wanted)}
    todo = [r for h, r in wanted.items() if h not in present]
    defaults = {c: None for c in LABEL_COLUMNS} | {"confidence": 1.0, "updated_at": time.time()}
    cols = ", ".join(LABEL_COLUMNS)
    conn.executemany(
        f"INSERT OR IGNORE INTO labels ({cols}) "
        f"VALUES ({', '.join('?' * len(LABEL_COLUMNS))})",
        [tuple((defaults | r)[c] for c in LABEL_COLUMNS) for r in todo],
    )
    conn.commit()
    if todo:
        events.publish(events.LABELS_CHANGED, hashes=len(todo))
    return len(todo), [h for h in wanted if h in present]


@dataclass(slots=True, frozen=True)
class Triage:
    """A conversation's written messages, sorted by what decides their
    Label. System lines have none and are in no part of it."""

    #: `(index into the messages, hash)` of each Unlabeled one, in Log
    #: order: what is left to judge.
    pending: list[tuple[int, str]]
    #: How many carry a stored Label.
    already_labelled: int
    #: How many the rules decide (empty, short, `((` prefix).
    decided_by_rules: int
    #: How many written messages there are.
    total: int


def triage(
    conn: sqlite3.Connection, messages: list[dict], settings: LabelsSettings
) -> Triage:
    """Sort `messages`, one conversation's Log, into those with a
    stored Label (looked up by hash, ADR 0004), those the rules decide
    and the Unlabeled rest."""
    by_hash = labels_for_messages(conn, messages)
    pending: list[tuple[int, str]] = []
    already_labelled = decided_by_rules = total = 0
    for idx, msg in enumerate(messages):
        if is_system_line(msg):
            continue
        total += 1
        h = msg_hash(msg)
        if h in by_hash:
            already_labelled += 1
        elif resolve(msg, None, settings) != LABEL_UNLABELED:
            decided_by_rules += 1
        else:
            pending.append((idx, h))
    return Triage(pending, already_labelled, decided_by_rules, total)


def fill_unlabeled(
    conn: sqlite3.Connection,
    messages: Iterable[dict],
    settings: LabelsSettings,
    label: str,
    *,
    source: str = "manual",
    reason: str = "bulk: all unlabeled",
) -> dict:
    """Give every still-Unlabeled message in one conversation the same
    verdict.

    For the case the user actually has: a conversation they know is
    pure IC end to end, where asking a model to judge two thousand
    messages one batch at a time buys nothing. They know the answer.

    Only the Unlabeled ones are touched. A message that already has a
    stored verdict keeps it — this is not a way to overwrite a model's
    work, and it never widens into one. Messages the rules already
    decided (empty, shorter than the threshold, `((` prefix) keep
    resolving through the rules, so a one-word IC line stays OOC here;
    that is what the rules are for, and the user can still override a
    single row by hand.

    `messages` is the conversation's Log; the Labels it already holds
    are found through their hashes (ADR 0004).

    Returns the counts plus every hash written, so the caller can offer
    to undo exactly this write and nothing else.
    """
    if label not in (LABEL_IC, LABEL_OOC):
        raise ValueError(f"invalid label: {label!r}")
    messages = list(messages)
    sorted_out = triage(conn, messages, settings)
    targets = [(h, messages[idx]) for idx, h in sorted_out.pending]

    now = time.time()
    conn.executemany(
        """
        INSERT INTO labels (
            hash, ts, speaker, label,
            confidence, reason, source, prior_label, prior_source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
        ON CONFLICT(hash) DO NOTHING
        """,
        [
            (
                h,
                int(msg.get("ts") or 0),
                msg.get("speaker") or "",
                label,
                1.0,
                reason,
                source,
                now,
            )
            for h, msg in targets
        ],
    )
    conn.commit()
    if targets:
        events.publish(events.LABELS_CHANGED, hashes=len(targets))
    return {
        "label": label,
        "labeled": len(targets),
        "hashes": [h for h, _ in targets],
        "already_labeled": sorted_out.already_labelled,
        "decided_by_rules": sorted_out.decided_by_rules,
        "total_messages": sorted_out.total,
    }


def delete_labels_by_hash(
    conn: sqlite3.Connection,
    hashes: Iterable[str],
) -> int:
    """Remove specific labels, reverting those messages to
    rule-or-Unlabeled. Undoes one `fill_unlabeled` without touching
    anything else in the conversation."""
    removed = 0
    for batch, placeholders in _hash_batches(hashes):
        cur = conn.execute(
            f"DELETE FROM labels WHERE hash IN ({placeholders})", batch
        )
        removed += cur.rowcount
    conn.commit()
    if removed:
        events.publish(events.LABELS_CHANGED, deleted=removed)
    return removed


def max_label_time(
    conn: sqlite3.Connection, messages: Iterable[dict]
) -> float | None:
    """The newest `updated_at` among the stored Labels of `messages`
    (one conversation's Log), or None when none of them has a Label.

    Used to flag stale-label rows in the partner list — compare against
    the log file's mtime to spot conversations that grew since their
    last classify run.
    """
    newest = None
    for row in _rows_for_hashes(conn, "updated_at", (msg_hash(m) for m in messages)):
        if newest is None or row["updated_at"] > newest:
            newest = row["updated_at"]
    return float(newest) if newest is not None else None


def stats(
    conn: sqlite3.Connection,
    messages: Iterable[dict],
    settings: LabelsSettings,
) -> dict[str, int]:
    """Count IC / OOC / Unlabeled across the supplied messages. System
    lines have no Label, so they are in none of the counts.

    Caller passes the already-parsed messages of a conversation (we
    don't re-walk the binary log, and its whole alias group is in
    them); their stored Labels are looked up by hash. Cheap because
    the lookup is a few batched queries and resolution is a dict hit
    per message.
    """
    messages = list(messages)
    by_hash = labels_for_messages(conn, messages)
    counts = {LABEL_IC: 0, LABEL_OOC: 0, LABEL_UNLABELED: 0}
    for msg in messages:
        lab = resolve(msg, by_hash.get(msg_hash(msg)), settings)
        if lab is not None:
            counts[lab] = counts.get(lab, 0) + 1
    return counts


# Condensed decision rule, shipped with every batch of messages to
# classify. The full prompt above is ~4 KB and lives in the caller's
# system prompt, which is exactly what a client evicts first when a long
# classification loop fills its context: a rolling window drops the
# oldest turns, and the oldest turn is the rulebook. The instruction to
# re-fetch it lives there too, so by the time it would help it is gone.
#
# This is the part that has to survive. It goes in the batch response
# instead, where it is always the most recent context, so a model can
# keep judging correctly with no memory of how it started.
COMPACT_RULES: dict[str, str] = {
    "de": (
        "Kernfrage: Passiert das Beschriebene JETZT in der Spielwelt (IC), "
        "oder reden Spieler darüber (OOC)?\n"
        "IC: Erzählung in dritter Person über irgendeine Figur, auch bei "
        "banalen Handlungen; direkte Rede mit Dialog-Tag; Umgebung, NPCs "
        "und Ereignisse erzählt, auch ohne eigenen Charakternamen; "
        "Konjunktiv als erzählte Handlung ('Sie würde die Tür öffnen', "
        "'Sollte er sich umdrehen, sieht er...').\n"
        "OOC: Vorschläge an den Mitspieler ('wir könnten', 'zum Beispiel', "
        "'was meinst du?'); Anekdoten aus dem echten Leben in erster "
        "Person; Würfel, Regelfragen, AFK; Text in (…) oder nach "
        "'OOC:' / '//'.\n"
        "Gemischt: der Hauptteil entscheidet — ein angehängter "
        "Klammerkommentar macht einen IC-Post nicht zu OOC.\n"
        "Ein Account kann mehrere Figuren sprechen; der Sprechername muss "
        "nicht die erzählte Figur sein."
    ),
    "en": (
        "Core question: is this happening NOW in the game world (IC), or "
        "are players talking about it (OOC)?\n"
        "IC: third-person narration about any figure, however mundane; "
        "direct speech with a dialogue tag; surroundings, NPCs and events "
        "narrated, even with no own character name; conditional phrasing "
        "as narrated action ('She would open the door', 'Should he turn "
        "around, he sees...').\n"
        "OOC: proposals to the other player ('we could', 'for example', "
        "'what do you think?'); first-person real-life anecdotes; dice, "
        "rule questions, afk; text in (…) or after 'OOC:' / '//'.\n"
        "Mixed: the main body decides — a trailing parenthetical does not "
        "turn an IC post into OOC.\n"
        "One account may voice several characters; the speaker name need "
        "not be the narrated figure."
    ),
}
COMPACT_RULES["minimal"] = COMPACT_RULES["en"]
