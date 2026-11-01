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

import labels as labels_store
import rag_embed
import rag_jobs
import rag_store
from fchat_logs import chat, parsed, utc, write_log


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


#: Re-ingest must keep the Index in step with the Logs and their current
#: Labels. Today it skips every chunk id it already holds, and a day's
#: chunk id does not change when its messages or Labels do, so the
#: Index goes stale. Spec #2 reconciles per conversation day.
STALE_INDEX = pytest.mark.xfail(
    strict=True,
    reason="re-ingest skips chunk ids it already holds, so the Index goes stale #2",
)


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
    import rag_rerank
    import settings as settings_store

    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
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
    from server import app

    log = tmp_path / "fchat" / ME / "logs" / PARTNER
    return TestClient(app), log


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


def _ingest(client: TestClient) -> None:
    res = client.post("/rag/ingest", json={"character": ME, "partner": PARTNER})
    assert res.status_code == 202, res.text
    job_id = res.json()["id"]
    _wait_until(
        lambda: client.get(f"/rag/jobs/{job_id}").json()["state"]
        in ("done", "failed", "cancelled"),
    )
    job = client.get(f"/rag/jobs/{job_id}").json()
    assert job["state"] == "done", job


def _ic_texts_found(question: str) -> list[str]:
    from services import retrieval

    hits = retrieval.search(question, scope={"character": ME, "partner": PARTNER}, top_k=50)
    return [h.text for h in hits.hits if h.label == "IC"]


def _opening_alone(client: TestClient, log: Path) -> None:
    """Day one: only OPENING, labelled IC and indexed."""
    write_log(log, [chat(ME, OPENING, at=utc(2024, 3, 9, 20))])
    _label(client, OPENING, "IC")
    _ingest(client)
    assert any(OPENING in t for t in _ic_texts_found("lighthouse"))


@STALE_INDEX
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

    assert any(REPLY_MARK in t for t in _ic_texts_found("blue lamp"))


@STALE_INDEX
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
    assert not any(REPLY_MARK in t for t in _ic_texts_found("blue lamp"))

    _label(client, REPLY, "IC")
    _ingest(client)

    assert any(REPLY_MARK in t for t in _ic_texts_found("blue lamp"))


@STALE_INDEX
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
    assert any(REPLY_MARK in t for t in _ic_texts_found("blue lamp"))

    _label(client, REPLY, new_label)
    _ingest(client)

    found = _ic_texts_found("blue lamp")
    assert not any(REPLY_MARK in t for t in found)
    # The day's other IC message is still there; the Index was not
    # simply emptied.
    assert any(OPENING in t for t in found)


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


# ---- /rag/ingest + /rag/jobs HTTP shape --------------------------------


@pytest.fixture
def api_client(
    workbench_dir: Path,  # noqa: ARG001
    isolated_registry: rag_jobs.JobRegistry,  # noqa: ARG001
) -> TestClient:
    from server import app

    return TestClient(app)


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
