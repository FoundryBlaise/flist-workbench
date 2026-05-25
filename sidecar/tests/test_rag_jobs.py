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


# ---- helpers ------------------------------------------------------------


def _msg(ts: int, text: str, speaker: str = "Bob", kind: str = "ic") -> dict:
    return {
        "ts": ts,
        "iso": "2026-01-01T00:00:00+00:00",
        "type": 0,
        "type_name": "chat",
        "speaker": speaker,
        "raw": text,
        "text": text,
        "mentions": [],
        "kind": kind,
    }


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


def test_job_skips_existing_on_rerun(
    workbench_dir: Path,  # noqa: ARG001
    monkeypatch: pytest.MonkeyPatch,
    isolated_registry: rag_jobs.JobRegistry,
) -> None:
    long = "z" * 300
    msgs = [_msg(1735689600, long, speaker="A")]
    _stub_one_partner(monkeypatch, "Char", "Partner", msgs)
    counter = _stub_embedding(monkeypatch, dimension=4)
    labels_conn = labels_store.connect()
    try:
        labels_store.upsert_label(
            labels_conn,
            hash=labels_store.msg_hash(msgs[0]),
            character="Char",
            partner="Partner",
            ts=msgs[0]["ts"],
            speaker="A",
            label="IC",
            source="manual",
        )
    finally:
        labels_conn.close()

    job1 = rag_jobs.start({"character": "Char", "partner": "Partner"})
    _wait_until(lambda: job1.state == "done", timeout=3.0)
    assert job1.progress.upserted == 1
    first_embed = counter["embed"]

    # Second run: same scope, no new messages. Should skip everything.
    job2 = rag_jobs.start({"character": "Char", "partner": "Partner"})
    _wait_until(lambda: job2.state == "done", timeout=3.0)
    assert job2.progress.upserted == 0
    assert job2.progress.skipped_existing == 1
    assert counter["embed"] == first_embed  # no new embeddings


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
        embed_model=rag_settings_mod.DEFAULT_EMBED_MODEL,
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
