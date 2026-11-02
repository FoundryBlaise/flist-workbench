-- settings.db as release v0.1.10 left it: the schema its own connect functions
-- created, and rows written through its own functions (labels, aliases,
-- Index manifest and keyword index, settings), dumped to SQL.
-- No user_version: releases up to v0.1.10 did not version their databases.
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('fchat_data_dir', 'C:/FChat/data');
INSERT INTO settings (key, value) VALUES ('labels.threshold_chars', '40');
INSERT INTO settings (key, value) VALUES ('labels.llm_endpoint', 'http://127.0.0.1:1234/v1');
INSERT INTO settings (key, value) VALUES ('labels.llm_api_key', 'sk-local-test');
INSERT INTO settings (key, value) VALUES ('rag.embed_model', 'bge-m3');
INSERT INTO settings (key, value) VALUES ('rag.chat_model', 'qwen');
INSERT INTO settings (key, value) VALUES ('rag.top_k', '8');
