"""rag_jobs tests — real chunker + embedded Qdrant, mocked embedding HTTP.

Same shape as test_labels_llm.py's job-manager block: we monkeypatch the
expensive boundaries (filesystem walk, HTTP embedding) so the test runs
in a fraction of a second while still exercising the full chunker +
Qdrant path.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sidecar_client import app_client

import labels as labels_store
import rag_embed
import rag_jobs
import rag_store
import two_characters as tc
from fchat_logs import chat, parsed, utc, write_log
from two_characters import two_characters  # noqa: F401  (the fixture is used by name)


# ---- helpers ------------------------------------------------------------


def _msg(ts: int, text: str, speaker: str = "Bob") -> dict:
    """One chat line as the parser reads it from a Log."""
    [msg] = parsed(chat(speaker, text, at=ts))
    return msg


def _wait_until(predicate, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(f"predicate never held within {timeout}s")


@pytest.fixture
def isolated_registry(monkeypatch: pytest.MonkeyPatch) -> rag_jobs.JobRegistry:
    fresh = rag_jobs.JobRegistry()
    monkeypatch.setattr(rag_jobs, "_registry", fresh)
    monkeypatch.setattr(rag_jobs, "registry", lambda: fresh)
    return fresh


@pytest.fixture
def workbench_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    # Chunking follows the embedding model's window, and these tests
    # stub the embedding away entirely. Pin a model with a wide window
    # so the fixtures keep the chunk boundaries they were written for.
    import settings as settings_store

    conn = settings_store.connect()
    try:
        settings_store.set_value(
            conn,
            settings_store.KEY_RAG_EMBED_MODEL,
            "jinaai/jina-embeddings-v2-base-en",
        )
    finally:
        conn.close()
    return tmp_path


def _stub_one_partner(
    monkeypatch: pytest.MonkeyPatch, character: str, partner: str, messages: list[dict]
) -> None:
    monkeypatch.setattr(
        rag_jobs.logs_store, "read_messages", lambda *a, **k: iter(messages)
    )
    monkeypatch.setattr(
        rag_jobs, "_resolve_targets", lambda scope: [(character, partner)]
    )


def _stub_embedding(
    monkeypatch: pytest.MonkeyPatch, *, dimension: int = 4
) -> dict[str, int]:
    """Replace probe + embed_texts with deterministic stubs. Returns a
    counter dict the test can read to assert how many embeddings ran.
    """
    counter = {"probe": 0, "embed": 0, "embed_calls": 0}

    def fake_probe(settings, *, timeout=30.0):  # noqa: ARG001
        counter["probe"] += 1
        return dimension, [0.0] * dimension

    def fake_embed_texts(texts, kind, settings, **_):  # noqa: ARG001
        counter["embed"] += len(texts)
        counter["embed_calls"] += 1
        return [[float(counter["embed"] + i)] * dimension for i in range(len(texts))]

    monkeypatch.setattr(rag_embed, "probe", fake_probe)
    monkeypatch.setattr(rag_embed, "embed_texts", fake_embed_texts)
    return counter


# ---- happy path --------------------------------------------------------


def test_job_runs_single_partner_to_done(
    workbench_dir: Path,  # noqa: ARG001
    monkeypatch: pytest.MonkeyPatch,
    isolated_registry: rag_jobs.JobRegistry,
) -> None:
    long = "y" * 300
    # Two IC messages on the same day → one chunk after grouping.
    msgs = [
        _msg(1735689600, long, speaker="A"),
        _msg(1735693200, long, speaker="B"),
    ]
    _stub_one_partner(monkeypatch, "Char", "Partner", msgs)
    counter = _stub_embedding(monkeypatch, dimension=8)

    # Seed manual IC labels so the chunker doesn't skip on Unlabeled.
    labels_conn = labels_store.connect()
    try:
        for m in msgs:
            labels_store.upsert_label(
                labels_conn,
                hash=labels_store.msg_hash(m),
                character="Char",
                partner="Partner",
                ts=m["ts"],
                speaker=m["speaker"],
                label="IC",
                source="manual",
            )
    finally:
        labels_conn.close()

    job = rag_jobs.start({"character": "Char", "partner": "Partner"})
    _wait_until(lambda: job.state in ("done", "failed", "cancelled"))
    assert job.state == "done", job.error
    assert job.embed_dimension == 8
    assert job.progress.chunked == 1
    assert job.progress.embedded == 1
    assert job.progress.upserted == 1
    assert job.progress.skipped_existing == 0
    assert counter["probe"] == 1


# ---- re-ingest reconciles the Index with the Logs and their Labels ------


ME, PARTNER = "Azure Viper", "Antiquill"
# Long enough that the short-message rule leaves them Unlabeled, so
# only an explicit Label puts them in the Index.
OPENING = (
    "Azure Viper leans on the rail of the night ferry and counts the "
    "lanterns along the harbour wall, one for every year she stayed away, "
    "and wonders aloud whether the old lighthouse keeper still keeps the "
    "blue lamp burning for ships that never come back."
)
REPLY = (
    "Antiquill sets down his cup and admits the keeper retired last "
    "winter, but the blue lamp still burns, because the whole town took "
    "turns climbing the stairs each night rather than let it go dark, "
    "and nobody ever decided who would stop first. Marmalade."
)
# A word only REPLY contains, to recognise it in a hit.
REPLY_MARK = "Marmalade"


@pytest.fixture
def index_window(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    isolated_registry: rag_jobs.JobRegistry,  # noqa: ARG001
):
    """The sidecar from outside over one fixture conversation: REST for
    Labels and ingest, the retrieval service for search. Embedding and
    reranking are stubbed. Returns (client, path of the Log)."""
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    _stub_index_services(monkeypatch)
    from server import app

    log = tmp_path / "fchat" / ME / "logs" / PARTNER
    return app_client(app), log


def _stub_index_services(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin a wide-window embedding model and stub embedding and
    reranking, for a data dir the caller already pointed the env at."""
    import rag_rerank
    import settings as settings_store

    conn = settings_store.connect()
    try:
        settings_store.set_value(
            conn,
            settings_store.KEY_RAG_EMBED_MODEL,
            "jinaai/jina-embeddings-v2-base-en",
        )
    finally:
        conn.close()
    _stub_embedding(monkeypatch, dimension=4)
    rag_rerank.reset_cache()

    class _FakeEncoder:
        def rerank(self, query: str, docs):  # noqa: ARG002
            return [float(len(d)) for d in docs]

    monkeypatch.setattr(rag_rerank, "_build_encoder", lambda *_a, **_k: _FakeEncoder())


def _label(client: TestClient, text: str, label: str | None) -> None:
    """Give the message whose text is `text` a Label (None clears it),
    the way the log view does."""
    res = client.get("/logs/messages", params={"char": ME, "partner": PARTNER})
    assert res.status_code == 200, res.text
    (msg,) = [m for m in res.json()["messages"] if m["text"] == text]
    res = client.post(
        "/labels/override",
        json={
            "character": ME,
            "partner": PARTNER,
            "hash": msg["hash"],
            "ts": msg["ts"],
            "speaker": msg["speaker"],
            "label": label,
        },
    )
    assert res.status_code == 200, res.text


def _ingest(
    client: TestClient, scope: dict | None = None, *, rebuild: bool = False
) -> dict:
    """Run one ingest the way the window starts it, of the fixture
    conversation unless `scope` says otherwise ({} for everything);
    returns the finished job."""
    body = {"character": ME, "partner": PARTNER} if scope is None else dict(scope)
    res = client.post("/rag/ingest", json={**body, "force_rewipe": rebuild})
    assert res.status_code == 202, res.text
    job_id = res.json()["id"]
    _wait_until(
        lambda: client.get(f"/rag/jobs/{job_id}").json()["state"]
        in ("done", "failed", "cancelled"),
    )
    job = client.get(f"/rag/jobs/{job_id}").json()
    assert job["state"] == "done", job
    return job


def _found_as_ic(mark: str, scope: dict | None = None) -> bool:
    """Whether a search finds `mark` in an IC chunk of the fixture
    conversation, or of `scope`. Asks the vector and the lexical Index
    separately and insists they agree on which chunks hold it."""
    import rag_lexical
    from services import retrieval

    if scope is None:
        scope = {"character": ME, "partner": PARTNER}
    # The stub embedding makes every chunk equally close, so a wide
    # top_k returns every chunk the vector Index holds for the scope.
    dense = retrieval.search(mark, scope=scope, top_k=50, neighbors=0, hybrid=False)
    dense_ids = {h.chunk_id for h in dense.hits if h.label == "IC" and mark in h.text}
    with rag_lexical.LexicalStore() as lex:
        lexical_ids = {h.chunk_id for h in lex.search(mark, scope=scope)}
    assert dense_ids == lexical_ids, (
        f"vector and lexical Index disagree on {mark!r}: "
        f"vector {sorted(dense_ids)}, lexical {sorted(lexical_ids)}"
    )
    return bool(dense_ids)


def _opening_alone(client: TestClient, log: Path) -> None:
    """Day one: only OPENING, labelled IC and indexed."""
    write_log(log, [chat(ME, OPENING, at=utc(2024, 3, 9, 20))])
    _label(client, OPENING, "IC")
    _ingest(client)
    assert _found_as_ic("lighthouse")


def test_a_message_appended_to_an_indexed_day_becomes_searchable(index_window) -> None:
    client, log = index_window
    _opening_alone(client, log)

    # F-Chat appends the reply to the same day; the user labels it.
    write_log(log, [
        chat(ME, OPENING, at=utc(2024, 3, 9, 20)),
        chat(PARTNER, REPLY, at=utc(2024, 3, 9, 21)),
    ])
    _label(client, REPLY, "IC")
    _ingest(client)

    assert _found_as_ic(REPLY_MARK)
    assert _found_as_ic("lighthouse")


def test_a_label_given_after_the_day_was_indexed_becomes_searchable(
    index_window,
) -> None:
    client, log = index_window
    write_log(log, [
        chat(ME, OPENING, at=utc(2024, 3, 9, 20)),
        chat(PARTNER, REPLY, at=utc(2024, 3, 9, 21)),
    ])
    _label(client, OPENING, "IC")
    _ingest(client)
    assert not _found_as_ic(REPLY_MARK)

    _label(client, REPLY, "IC")
    _ingest(client)

    assert _found_as_ic(REPLY_MARK)


@pytest.mark.parametrize("new_label", ["OOC", None], ids=["flipped-to-ooc", "cleared"])
def test_a_message_whose_label_flipped_or_was_cleared_drops_out(
    index_window, new_label: str | None
) -> None:
    client, log = index_window
    write_log(log, [
        chat(ME, OPENING, at=utc(2024, 3, 9, 20)),
        chat(PARTNER, REPLY, at=utc(2024, 3, 9, 21)),
    ])
    _label(client, OPENING, "IC")
    _label(client, REPLY, "IC")
    _ingest(client)
    assert _found_as_ic(REPLY_MARK)

    _label(client, REPLY, new_label)
    _ingest(client)

    assert not _found_as_ic(REPLY_MARK)
    # The day's other IC message is still there; the Index was not
    # simply emptied.
    assert _found_as_ic("lighthouse")


def test_a_re_ingest_with_nothing_changed_embeds_nothing(index_window) -> None:
    client, log = index_window
    write_log(log, [
        chat(ME, OPENING, at=utc(2024, 3, 9, 20)),
        chat(PARTNER, REPLY, at=utc(2024, 3, 10, 21)),
    ])
    _label(client, OPENING, "IC")
    _label(client, REPLY, "IC")
    assert _ingest(client)["embedded"] == 2

    again = _ingest(client)

    assert again["embedded"] == 0
    assert again["skipped_existing"] == 2
    assert _found_as_ic(REPLY_MARK)
    assert _found_as_ic("lighthouse")


def test_a_new_day_embeds_only_that_day(index_window) -> None:
    client, log = index_window
    _opening_alone(client, log)

    write_log(log, [
        chat(ME, OPENING, at=utc(2024, 3, 9, 20)),
        chat(PARTNER, REPLY, at=utc(2024, 3, 12, 21)),
    ])
    _label(client, REPLY, "IC")
    job = _ingest(client)

    assert job["embedded"] == 1
    assert _found_as_ic(REPLY_MARK)
    assert _found_as_ic("lighthouse")


def test_job_writes_manifest_after_first_ingest(
    workbench_dir: Path,  # noqa: ARG001
    monkeypatch: pytest.MonkeyPatch,
    isolated_registry: rag_jobs.JobRegistry,
) -> None:
    msgs = [_msg(1735689600, "x" * 300)]
    _stub_one_partner(monkeypatch, "Char", "Partner", msgs)
    _stub_embedding(monkeypatch, dimension=12)
    labels_conn = labels_store.connect()
    try:
        labels_store.upsert_label(
            labels_conn,
            hash=labels_store.msg_hash(msgs[0]),
            character="Char",
            partner="Partner",
            ts=msgs[0]["ts"],
            speaker="Bob",
            label="IC",
            source="manual",
        )
    finally:
        labels_conn.close()

    job = rag_jobs.start({"character": "Char", "partner": "Partner"})
    _wait_until(lambda: job.state == "done", timeout=3.0)
    manifest = rag_store.read_manifest()
    assert manifest.embed_dimension == 12
    assert manifest.embed_model  # whatever the default model was


# ---- failure modes -----------------------------------------------------


def test_job_fails_when_probe_fails(
    workbench_dir: Path,  # noqa: ARG001
    monkeypatch: pytest.MonkeyPatch,
    isolated_registry: rag_jobs.JobRegistry,
) -> None:
    msgs = [_msg(1735689600, "x" * 300)]
    _stub_one_partner(monkeypatch, "Char", "Partner", msgs)

    def boom(settings, *, timeout=30.0):  # noqa: ARG001
        raise rag_embed.EmbedError("model not loaded")

    monkeypatch.setattr(rag_embed, "probe", boom)
    job = rag_jobs.start({"character": "Char", "partner": "Partner"})
    _wait_until(lambda: job.state in ("done", "failed", "cancelled"))
    assert job.state == "failed"
    assert "model not loaded" in (job.error or "")
    assert job.progress.upserted == 0


def test_job_detects_dim_mismatch_and_aborts(
    workbench_dir: Path,  # noqa: ARG001
    monkeypatch: pytest.MonkeyPatch,
    isolated_registry: rag_jobs.JobRegistry,
) -> None:
    # Seed an old manifest with dim 16.
    rag_store.write_manifest(embed_model="old-model", embed_dimension=16)

    msgs = [_msg(1735689600, "x" * 300)]
    _stub_one_partner(monkeypatch, "Char", "Partner", msgs)
    _stub_embedding(monkeypatch, dimension=8)  # probe returns 8 now
    labels_conn = labels_store.connect()
    try:
        labels_store.upsert_label(
            labels_conn,
            hash=labels_store.msg_hash(msgs[0]),
            character="Char",
            partner="Partner",
            ts=msgs[0]["ts"],
            speaker="Bob",
            label="IC",
            source="manual",
        )
    finally:
        labels_conn.close()

    job = rag_jobs.start({"character": "Char", "partner": "Partner"})
    _wait_until(lambda: job.state in ("done", "failed", "cancelled"))
    assert job.state == "failed"
    assert job.model_swap is True
    assert "embedding model changed" in (job.error or "")


def test_job_detects_orphan_collection_as_model_swap(
    workbench_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    isolated_registry: rag_jobs.JobRegistry,
) -> None:
    """Manifest is empty but a 768-dim Qdrant collection survives from
    a previous build at a different dim. ensure_collection raises
    DimensionMismatchError, and the job must surface that as
    model_swap=True (not as a generic Exception) so the UI gives the
    user the Wipe + re-ingest path instead of the cryptic broadcast
    ValueError they used to see.
    """
    # Seed an orphan 4-dim collection at the canonical path.
    store = rag_store.RagStore()
    try:
        store.ensure_collection(vector_size=4)
    finally:
        store.close()
    # Don't write a manifest — that's the regression: manifest empty
    # while the collection on disk says 4 dims.

    msgs = [_msg(1735689600, "x" * 300)]
    _stub_one_partner(monkeypatch, "Char", "Partner", msgs)
    # Probe returns a different dim (8) → ensure_collection mismatch.
    _stub_embedding(monkeypatch, dimension=8)
    labels_conn = labels_store.connect()
    try:
        labels_store.upsert_label(
            labels_conn,
            hash=labels_store.msg_hash(msgs[0]),
            character="Char",
            partner="Partner",
            ts=msgs[0]["ts"],
            speaker="Bob",
            label="IC",
            source="manual",
        )
    finally:
        labels_conn.close()

    job = rag_jobs.start({"character": "Char", "partner": "Partner"})
    _wait_until(lambda: job.state in ("done", "failed", "cancelled"), timeout=5.0)
    assert job.state == "failed"
    assert job.model_swap is True
    assert "vector index has dimension 4" in (job.error or "")


def test_job_scoped_force_rewipe_deletes_only_that_scope(
    workbench_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    isolated_registry: rag_jobs.JobRegistry,
) -> None:
    """A per-conversation force_rewipe must only delete that
    conversation's chunks, not nuke the whole collection. Verifies the
    scope-aware wipe added to _run_job.
    """
    # Pre-seed chunks for two partners. Both at 4 dims.
    store = rag_store.RagStore()
    try:
        store.ensure_collection(vector_size=4)
        store.upsert_chunks(
            [
                {
                    "chunk_id": "Char__A__2026-01-01__IC#0",
                    "char_owner": "Char",
                    "partner": "A",
                    "date": "2026-01-01",
                    "label": "IC",
                    "subchunk": 0,
                    "ts_start": 0,
                    "ts_end": 1,
                    "speakers": ["Char"],
                    "msg_count": 1,
                    "char_count": 1,
                    "text": "old A chunk",
                    "prev_chunk_id": None,
                    "next_chunk_id": None,
                },
                {
                    "chunk_id": "Char__B__2026-01-01__IC#0",
                    "char_owner": "Char",
                    "partner": "B",
                    "date": "2026-01-01",
                    "label": "IC",
                    "subchunk": 0,
                    "ts_start": 0,
                    "ts_end": 1,
                    "speakers": ["Char"],
                    "msg_count": 1,
                    "char_count": 1,
                    "text": "old B chunk",
                    "prev_chunk_id": None,
                    "next_chunk_id": None,
                },
            ],
            [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]],
        )
    finally:
        store.close()
    # Manifest must match the loaded RagSettings model name too, not
    # just the dim — otherwise the loader's default model name vs our
    # stored "m" trips the mismatch branch and the world gets nuked
    # instead of just scope A.
    import rag as rag_settings_mod

    rag_store.write_manifest(
        # The loaded name, not the module default — the fixture pins a
        # wide-window model, and a mismatch here reads as a model swap
        # and wipes everything instead of just scope A.
        embed_model=rag_settings_mod.load_settings().embed_model,
        embed_dimension=4,
    )

    msgs = [_msg(1735689600, "y" * 300)]
    _stub_one_partner(monkeypatch, "Char", "A", msgs)
    _stub_embedding(monkeypatch, dimension=4)
    # The settings loader uses the saved labels endpoint by default.
    # Embedding probe + embed are both stubbed so this doesn't matter.
    labels_conn = labels_store.connect()
    try:
        labels_store.upsert_label(
            labels_conn,
            hash=labels_store.msg_hash(msgs[0]),
            character="Char",
            partner="A",
            ts=msgs[0]["ts"],
            speaker="Bob",
            label="IC",
            source="manual",
        )
    finally:
        labels_conn.close()

    job = rag_jobs.start(
        {"character": "Char", "partner": "A"}, force_rewipe=True
    )
    _wait_until(lambda: job.state in ("done", "failed", "cancelled"), timeout=5.0)
    assert job.state == "done", job.error

    # Partner A's old chunk should be gone; the re-ingest produces a
    # new chunk under the same partner. Partner B's chunk must survive.
    store = rag_store.RagStore()
    try:
        all_ids = store.existing_chunk_ids()
    finally:
        store.close()
    assert "Char__B__2026-01-01__IC#0" in all_ids
    # Old A chunk had a different content/date so its chunk_id differs
    # from any chunk the chunker would produce now — confirm the pre-
    # seeded one was removed.
    assert "Char__A__2026-01-01__IC#0" not in all_ids


def test_job_with_force_rewipe_recreates_collection(
    workbench_dir: Path,  # noqa: ARG001
    monkeypatch: pytest.MonkeyPatch,
    isolated_registry: rag_jobs.JobRegistry,
) -> None:
    rag_store.write_manifest(embed_model="old-model", embed_dimension=16)

    msgs = [_msg(1735689600, "x" * 300)]
    _stub_one_partner(monkeypatch, "Char", "Partner", msgs)
    _stub_embedding(monkeypatch, dimension=8)
    labels_conn = labels_store.connect()
    try:
        labels_store.upsert_label(
            labels_conn,
            hash=labels_store.msg_hash(msgs[0]),
            character="Char",
            partner="Partner",
            ts=msgs[0]["ts"],
            speaker="Bob",
            label="IC",
            source="manual",
        )
    finally:
        labels_conn.close()

    job = rag_jobs.start(
        {"character": "Char", "partner": "Partner"}, force_rewipe=True
    )
    _wait_until(lambda: job.state in ("done", "failed", "cancelled"), timeout=5.0)
    assert job.state == "done", job.error
    manifest = rag_store.read_manifest()
    assert manifest.embed_dimension == 8


# ---- a rebuild deletes only its scope ----------------------------------


AZURE_SCOPE = {"character": tc.AZURE, "partner": tc.PARTNER}
AMBER_SCOPE = {"character": tc.AMBER, "partner": tc.PARTNER}


@pytest.fixture
def two_labelled(
    two_characters: tc.TwoCharacters,
    monkeypatch: pytest.MonkeyPatch,
    isolated_registry: rag_jobs.JobRegistry,  # noqa: ARG001
) -> tc.TwoCharacters:
    """The two-character scenario with one lighthouse line per own
    character labelled IC, nothing indexed yet."""
    _stub_index_services(monkeypatch)
    two_characters.label_by_hand(tc.AZURE, tc.PARTNER, tc.PARTNER_LINE, "IC")
    two_characters.label_by_hand(tc.AMBER, tc.PARTNER, tc.AMBER_PARTNER_LINE, "IC")
    return two_characters


def _seed_stale_chunk(character: str, partner: str, text: str) -> None:
    """A chunk in both indexes for a conversation the Logs no longer
    have, as an old ingest may have left behind. Only a rebuild over its
    scope removes it."""
    import rag_lexical

    chunk = {
        "chunk_id": f"{character}__{partner}__2020-01-01__IC#0",
        "char_owner": character,
        "partner": partner,
        "date": "2020-01-01",
        "label": "IC",
        "subchunk": 0,
        "ts_start": 0,
        "ts_end": 1,
        "speakers": [character],
        "msg_count": 1,
        "char_count": len(text),
        "text": text,
        "prev_chunk_id": None,
        "next_chunk_id": None,
    }
    with rag_store.RagStore() as store:
        store.ensure_collection(vector_size=4)
        store.upsert_chunks([chunk], [[1.0, 0.0, 0.0, 0.0]])
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks([chunk])


def test_a_rebuild_of_one_character_leaves_another_characters_index(
    two_labelled: tc.TwoCharacters,
) -> None:
    client = two_labelled.client
    _ingest(client, {})
    _seed_stale_chunk(tc.AZURE, "Mossgrave", "Azure's old harbour quarrel")
    _seed_stale_chunk(tc.AMBER, "Mossgrave", "Amber's old harbour quarrel")
    azure_stale = {"character": tc.AZURE, "partner": "Mossgrave"}
    amber_stale = {"character": tc.AMBER, "partner": "Mossgrave"}
    assert _found_as_ic("quarrel", azure_stale)

    _ingest(client, {"character": tc.AZURE}, rebuild=True)

    # The rebuilt character's scope was emptied and filled again.
    assert not _found_as_ic("quarrel", azure_stale)
    assert _found_as_ic(tc.SEARCH_TERM, AZURE_SCOPE)
    # The other character's Index was not touched.
    assert _found_as_ic(tc.SEARCH_TERM, AMBER_SCOPE)
    assert _found_as_ic("quarrel", amber_stale)


def test_an_unscoped_rebuild_empties_the_whole_index_first(
    two_labelled: tc.TwoCharacters,
) -> None:
    client = two_labelled.client
    _ingest(client, {})
    _seed_stale_chunk(tc.AMBER, "Mossgrave", "Amber's old harbour quarrel")
    _seed_stale_chunk("Retired Name", "Mossgrave", "a retired character's quarrel")
    retired = {"character": "Retired Name", "partner": "Mossgrave"}
    assert _found_as_ic("quarrel", retired)

    _ingest(client, {}, rebuild=True)

    assert not _found_as_ic("quarrel", {"character": tc.AMBER, "partner": "Mossgrave"})
    assert not _found_as_ic("quarrel", retired)
    assert _found_as_ic(tc.SEARCH_TERM, AZURE_SCOPE)
    assert _found_as_ic(tc.SEARCH_TERM, AMBER_SCOPE)


# ---- ingest resolves scope names like every other tool -----------------


@pytest.mark.parametrize(
    ("scope", "indexed"),
    [
        ({"character": "azure viper", "partner": "ANTIQUILL"}, AZURE_SCOPE),
        ({"character": tc.AZURE, "partner": "quill ashgrove"}, AZURE_SCOPE),
        ({"character": "lady amber blaise"}, AMBER_SCOPE),
    ],
    ids=["different-case", "alias-of-the-partner", "character-only-different-case"],
)
async def test_mcp_ingest_resolves_scope_names_to_the_conversation(
    two_labelled: tc.TwoCharacters, scope: dict, indexed: dict
) -> None:
    from mcp_helpers import call_tool, mcp_client

    async with mcp_client("logs") as session:
        result, body = await call_tool(session, "ingest_logs", **scope)

    assert not result.isError, body
    assert body["state"] == "done", body
    assert _found_as_ic(tc.SEARCH_TERM, indexed)


@pytest.mark.parametrize(
    ("scope", "code"),
    [
        ({"character": "Nobody Here"}, "log_character_not_found"),
        ({"character": tc.AZURE, "partner": "Nobody Here"}, "partner_not_found"),
    ],
    ids=["unknown-character", "unknown-partner"],
)
async def test_mcp_ingest_of_an_unknown_name_is_refused(
    two_labelled: tc.TwoCharacters, scope: dict, code: str
) -> None:
    from mcp_helpers import call_tool, mcp_client, tool_error_text

    async with mcp_client("logs") as session:
        result, _ = await call_tool(session, "ingest_logs", **scope)

    assert code in tool_error_text(result)
    assert rag_jobs.registry().list() == [], "no job was started"


def test_an_ingest_from_the_window_resolves_scope_names(
    two_labelled: tc.TwoCharacters,
) -> None:
    _ingest(two_labelled.client, {"character": "azure viper", "partner": "quill ashgrove"})

    assert _found_as_ic(tc.SEARCH_TERM, AZURE_SCOPE)


@pytest.mark.parametrize(
    ("scope", "code"),
    [
        ({"character": "Nobody Here"}, "log_character_not_found"),
        ({"character": tc.AZURE, "partner": "Nobody Here"}, "partner_not_found"),
    ],
    ids=["unknown-character", "unknown-partner"],
)
def test_an_ingest_from_the_window_of_an_unknown_name_is_refused(
    two_labelled: tc.TwoCharacters, scope: dict, code: str
) -> None:
    res = two_labelled.client.post("/rag/ingest", json=scope)

    assert res.status_code == 404, res.text
    assert res.json()["code"] == code
    assert res.json()["message"]
    assert rag_jobs.registry().list() == [], "no job was started"


# ---- /rag/ingest + /rag/jobs HTTP shape --------------------------------


@pytest.fixture
def api_client(
    workbench_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    isolated_registry: rag_jobs.JobRegistry,  # noqa: ARG001
) -> TestClient:
    # The route resolves scope names against the Logs, so Char and
    # Partner need a Log; the tests stub what is read from it.
    fchat = workbench_dir / "fchat"
    monkeypatch.setenv("FCHAT_DATA_DIR", str(fchat))
    write_log(fchat / "Char" / "logs" / "Partner", [chat("Partner", "Hi.", at=utc(2025, 1, 1))])
    from server import app

    return app_client(app)


def test_ingest_endpoint_rejects_partner_without_character(
    api_client: TestClient,
) -> None:
    res = api_client.post("/rag/ingest", json={"partner": "X"})
    assert res.status_code == 400
    assert "character" in res.json()["detail"]


def test_ingest_endpoint_returns_job_id(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    msgs = [_msg(1735689600, "x" * 300)]
    _stub_one_partner(monkeypatch, "Char", "Partner", msgs)
    _stub_embedding(monkeypatch, dimension=4)
    labels_conn = labels_store.connect()
    try:
        labels_store.upsert_label(
            labels_conn,
            hash=labels_store.msg_hash(msgs[0]),
            character="Char",
            partner="Partner",
            ts=msgs[0]["ts"],
            speaker="Bob",
            label="IC",
            source="manual",
        )
    finally:
        labels_conn.close()
    res = api_client.post(
        "/rag/ingest", json={"character": "Char", "partner": "Partner"}
    )
    assert res.status_code == 202
    job = res.json()
    assert "id" in job
    assert job["state"] in ("pending", "running", "done")

    _wait_until(
        lambda: rag_jobs.registry().get(job["id"]).state
        in ("done", "failed", "cancelled"),
        timeout=3.0,
    )
    finished = api_client.get(f"/rag/jobs/{job['id']}").json()
    assert finished["state"] == "done"


def test_get_unknown_job_returns_404(api_client: TestClient) -> None:
    assert api_client.get("/rag/jobs/zzz").status_code == 404
    assert api_client.delete("/rag/jobs/zzz").status_code == 404


def test_rag_status_blank_install(api_client: TestClient) -> None:
    res = api_client.get("/rag/status").json()
    assert res["embed_model"] is None
    assert res["embed_dimension"] is None
    assert res["chunk_count"] == 0
    assert res["last_ingest_at"] is None


def test_rag_status_after_ingest(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    msgs = [_msg(1735689600, "x" * 300)]
    _stub_one_partner(monkeypatch, "Char", "Partner", msgs)
    _stub_embedding(monkeypatch, dimension=4)
    labels_conn = labels_store.connect()
    try:
        labels_store.upsert_label(
            labels_conn,
            hash=labels_store.msg_hash(msgs[0]),
            character="Char",
            partner="Partner",
            ts=msgs[0]["ts"],
            speaker="Bob",
            label="IC",
            source="manual",
        )
    finally:
        labels_conn.close()
    res = api_client.post(
        "/rag/ingest", json={"character": "Char", "partner": "Partner"}
    ).json()
    _wait_until(
        lambda: rag_jobs.registry().get(res["id"]).state
        in ("done", "failed", "cancelled"),
        timeout=3.0,
    )

    status = api_client.get("/rag/status").json()
    assert status["embed_dimension"] == 4
    assert status["chunk_count"] >= 1


def test_channels_are_left_out_of_the_ingest_scope(monkeypatch, workbench_dir) -> None:
    """Group chat is not this character's roleplay, and there is a lot of
    it — on a real archive the channels carried two thirds of every
    unjudged message. list_partners hides them; the ingest used not to."""

    class _Entry:
        def __init__(self, name: str) -> None:
            self.name = name
            self.bytes = 1
            self.aliases = ()

    monkeypatch.setattr(
        rag_jobs.logs_store, "list_partners",
        lambda _c: [_Entry("Envale"), _Entry("#german ooc"), _Entry("#adh-abc")],
    )
    targets = rag_jobs._resolve_targets({"character": "Amber"})
    assert targets == [("Amber", "Envale")]

    with_channels = rag_jobs._resolve_targets(
        {"character": "Amber", "include_channels": True}
    )
    assert [p for _, p in with_channels] == ["Envale", "#german ooc", "#adh-abc"]


async def test_labels_changed_over_mcp_reach_the_index_on_the_next_ingest(
    index_window,
) -> None:
    from mcp_helpers import call_tool, mcp_client

    _client, log = index_window
    write_log(log, [
        chat(ME, OPENING, at=utc(2024, 3, 9, 20)),
        chat(PARTNER, REPLY, at=utc(2024, 3, 9, 21)),
    ])
    conv = {"character": ME, "partner": PARTNER}

    async with mcp_client("logs") as session:
        _, read = await call_tool(session, "read_log_messages", **conv)
        hash_of = {m["text"]: m["hash"] for m in read["messages"]}

        async def label(text: str, verdict: str) -> dict:
            _, body = await call_tool(
                session, "set_message_labels", **conv,
                items=[{"hash": hash_of[text], "label": verdict}],
            )
            return body

        async def ingest() -> dict:
            _, body = await call_tool(session, "ingest_logs", **conv)
            assert body["state"] == "done", body
            return body

        await label(OPENING, "IC")
        await ingest()
        assert _found_as_ic("lighthouse")
        assert not _found_as_ic(REPLY_MARK)

        labelled = await label(REPLY, "IC")
        # The note says what makes the new Label searchable, and that
        # it has not happened yet.
        assert "next ingest_logs" in labelled["note"]
        assert not _found_as_ic(REPLY_MARK)
        await ingest()
        assert _found_as_ic(REPLY_MARK)
        _, hits = await call_tool(
            session, "search_logs_semantic", question=REPLY_MARK, top_k=50, **conv
        )
        assert any(REPLY_MARK in h["text"] for h in hits["hits"])

        await label(REPLY, "OOC")
        await ingest()
        assert not _found_as_ic(REPLY_MARK)
        assert _found_as_ic("lighthouse")

        _, cleared = await call_tool(session, "clear_labels", **conv, confirm=True)
        assert "next ingest_logs" in cleared["note"]
        assert _found_as_ic("lighthouse"), "clearing alone leaves the Index as it was"
        after = await ingest()
        assert after["chunks_removed"] == 1
        assert not _found_as_ic("lighthouse")
