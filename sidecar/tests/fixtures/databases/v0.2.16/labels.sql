-- labels.db as release v0.2.16 left it: the schema its own connect functions
-- created, and rows written through its own functions (labels, aliases,
-- Index manifest and keyword index, settings), dumped to SQL.
-- No user_version: releases up to v0.2.16 did not version their databases.
CREATE TABLE labels (
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
CREATE INDEX idx_labels_partner ON labels(character, partner);
CREATE INDEX idx_labels_ts ON labels(ts);
CREATE TABLE partner_aliases (
    character     TEXT NOT NULL,
    name          TEXT NOT NULL,
    primary_name  TEXT NOT NULL,
    created_at    REAL NOT NULL,
    PRIMARY KEY (character, name)
);
CREATE INDEX idx_aliases_primary
    ON partner_aliases(character, primary_name);
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
INSERT INTO labels (hash, character, partner, ts, speaker, label, confidence, reason, source, prior_label, prior_source, updated_at) VALUES ('h-mcp', 'Ayla', 'Brin', 1700000000, 'Brin', 'IC', 1.0, 'narration', 'mcp', NULL, NULL, 1.793649984887848378e+09);
INSERT INTO labels (hash, character, partner, ts, speaker, label, confidence, reason, source, prior_label, prior_source, updated_at) VALUES ('h-manual', 'Ayla', 'Brin', 1700000060, 'Ayla', 'IC', 1.0, NULL, 'manual', 'OOC', 'mcp', 1.793649984909378051e+09);
INSERT INTO labels (hash, character, partner, ts, speaker, label, confidence, reason, source, prior_label, prior_source, updated_at) VALUES ('h-llm', 'Ayla', 'Cass', 1690000000, 'Cass', 'OOC', 1.0, NULL, 'llm', NULL, NULL, 1.793649984911885024e+09);
INSERT INTO partner_aliases (character, name, primary_name, created_at) VALUES ('Ayla', 'Brin', 'Brin', 1.793649984913886308e+09);
INSERT INTO partner_aliases (character, name, primary_name, created_at) VALUES ('Ayla', 'Brin Old', 'Brin', 1.793649984913886308e+09);
INSERT INTO rag_meta (key, value, updated_at) VALUES ('embed_model', 'BAAI/bge-small-en-v1.5', 1.793649984919403791e+09);
INSERT INTO rag_meta (key, value, updated_at) VALUES ('embed_dimension', '384', 1.793649984919403791e+09);
INSERT INTO rag_meta (key, value, updated_at) VALUES ('last_ingest_at', '1793649984.9194038', 1.793649984919403791e+09);
INSERT INTO rag_fts (chunk_id, char_owner, partner, text) VALUES ('Ayla|Brin|2023-11-14|0', 'Ayla', 'Brin', 'The lantern flickered over the harbour.');
