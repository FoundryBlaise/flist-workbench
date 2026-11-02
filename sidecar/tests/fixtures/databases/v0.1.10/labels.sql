-- labels.db as release v0.1.10 left it: the schema its own connect functions
-- created, and rows written through its own functions (labels, aliases,
-- Index manifest and keyword index, settings), dumped to SQL.
-- No user_version: releases up to v0.1.10 did not version their databases.
CREATE TABLE labels (
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
CREATE INDEX idx_labels_partner ON labels(character, partner);
CREATE INDEX idx_labels_ts ON labels(ts);
CREATE TABLE label_jobs (
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
CREATE INDEX idx_label_jobs_finished
    ON label_jobs(finished_at DESC);
CREATE TABLE partner_aliases (
    character     TEXT NOT NULL,
    name          TEXT NOT NULL,
    primary_name  TEXT NOT NULL,
    created_at    REAL NOT NULL,
    PRIMARY KEY (character, name)
);
CREATE INDEX idx_aliases_primary
    ON partner_aliases(character, primary_name);
CREATE TABLE label_failures (
    hash         TEXT PRIMARY KEY,
    character    TEXT NOT NULL,
    partner      TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    speaker      TEXT NOT NULL,
    error        TEXT NOT NULL,
    updated_at   REAL NOT NULL
);
CREATE INDEX idx_label_failures_partner
    ON label_failures(character, partner);
CREATE TABLE rag_meta (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE VIRTUAL TABLE rag_fts USING fts5(
    chunk_id    UNINDEXED,
    char_owner  UNINDEXED,
    partner     UNINDEXED,
    text,
    tokenize='unicode61 remove_diacritics 2'
);
INSERT INTO labels (hash, character, partner, ts, speaker, label, confidence, reason, source, prior_label, prior_source, updated_at) VALUES ('h-llm', 'Ayla', 'Brin', 1700000000, 'Brin', 'IC', 1.0, 'narration', 'llm', NULL, NULL, 1.793650028939241887e+09);
INSERT INTO labels (hash, character, partner, ts, speaker, label, confidence, reason, source, prior_label, prior_source, updated_at) VALUES ('h-manual', 'Ayla', 'Brin', 1700000060, 'Ayla', 'IC', 1.0, NULL, 'manual', 'OOC', 'llm', 1.793650028944250346e+09);
INSERT INTO label_jobs (id, scope, state, classified, failed, total, started_at, finished_at, error) VALUES ('job-1', '{"character": "Ayla"}', 'done', 2, 1, 3, 1700000000.0, 1700000100.0, NULL);
INSERT INTO partner_aliases (character, name, primary_name, created_at) VALUES ('Ayla', 'Brin', 'Brin', 1.793650028951260329e+09);
INSERT INTO partner_aliases (character, name, primary_name, created_at) VALUES ('Ayla', 'Brin Old', 'Brin', 1.793650028951260329e+09);
INSERT INTO label_failures (hash, character, partner, ts, speaker, error, updated_at) VALUES ('h-failed', 'Ayla', 'Brin', 1700000120, 'Brin', 'timeout', 1.793650028946751594e+09);
INSERT INTO rag_meta (key, value, updated_at) VALUES ('embed_model', 'bge-m3', 1.793650028956258774e+09);
INSERT INTO rag_meta (key, value, updated_at) VALUES ('embed_dimension', '1024', 1.793650028956258774e+09);
INSERT INTO rag_meta (key, value, updated_at) VALUES ('last_ingest_at', '1793650028.9562588', 1.793650028956258774e+09);
INSERT INTO rag_fts (chunk_id, char_owner, partner, text) VALUES ('Ayla|Brin|2023-11-14|0', 'Ayla', 'Brin', 'The lantern flickered over the harbour.');
