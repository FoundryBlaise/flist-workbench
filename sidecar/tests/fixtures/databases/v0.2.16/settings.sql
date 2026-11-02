-- settings.db as release v0.2.16 left it: the schema its own connect functions
-- created, and rows written through its own functions (labels, aliases,
-- Index manifest and keyword index, settings), dumped to SQL.
-- No user_version: releases up to v0.2.16 did not version their databases.
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('fchat_data_dir', 'C:/FChat/data');
INSERT INTO settings (key, value) VALUES ('labels.threshold_chars', '40');
INSERT INTO settings (key, value) VALUES ('rag.embed_model', 'BAAI/bge-small-en-v1.5');
INSERT INTO settings (key, value) VALUES ('backups.scheduled_interval_days', '7');
INSERT INTO settings (key, value) VALUES ('backups.last_sweep_source', 'scheduled');
