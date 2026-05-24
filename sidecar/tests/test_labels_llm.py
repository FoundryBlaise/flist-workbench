"""Tests for the LLM classifier and the job manager.

The LLM is mocked via monkeypatching urlopen — no network needed.
"""

from __future__ import annotations

import io
import json
import threading
import time
from pathlib import Path
from typing import Iterable

import pytest

import labels as labels_store
import labels_llm
import labels_jobs


# ---- helpers ------------------------------------------------------------


def _msg(ts: int, raw: str, speaker: str = "Bob") -> dict:
    return {
        "ts": ts,
        "iso": "2023-11-14T22:13:20+00:00",
        "type": 0,
        "type_name": "chat",
        "speaker": speaker,
        "raw": raw,
        "text": raw,
        "mentions": [],
        "kind": "ic",
    }


def _settings(threshold: int = 200) -> labels_store.LabelsSettings:
    return labels_store.LabelsSettings(
        threshold_chars=threshold,
        llm_endpoint="http://fake.local/v1",
        llm_model="test-model",
        llm_api_key="",
        system_prompt="classify ic or ooc",
    )


class _FakeResp:
    def __init__(self, payload: dict) -> None:
        self._body = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeResp":
        return self

    def __exit__(self, *_: object) -> None:
        return None


def _mk_urlopen(responses: Iterable[str | Exception]):
    """Build a urlopen replacement that returns canned content strings.

    Each call pops one item from the sequence. An Exception raises.
    """
    queue = list(responses)
    calls: list[bytes] = []

    def fake(req, timeout=None):  # noqa: ARG001
        calls.append(req.data or b"")
        if not queue:
            raise AssertionError("urlopen called more times than expected")
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return _FakeResp({
            "choices": [{"message": {"content": item}}]
        })

    return fake, calls


# ---- parse_label --------------------------------------------------------


def test_parse_label_strips_fences_and_extracts_json() -> None:
    out = labels_llm.parse_label('```json\n{"label":"IC","confidence":0.9,"reason":"narrative"}\n```')
    assert out == {"label": "IC", "confidence": 0.9, "reason": "narrative"}


def test_parse_label_clamps_confidence() -> None:
    assert labels_llm.parse_label('{"label":"OOC","confidence":1.7}')["confidence"] == 1.0
    assert labels_llm.parse_label('{"label":"OOC","confidence":-0.2}')["confidence"] == 0.0


def test_parse_label_rejects_garbage() -> None:
    assert labels_llm.parse_label("not json at all") is None
    assert labels_llm.parse_label('{"label":"MAYBE"}') is None


# ---- call_llm payload + headers ----------------------------------------


def test_call_llm_includes_bearer_when_api_key_set(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        captured["headers"] = dict(req.header_items())
        captured["url"] = req.full_url
        captured["data"] = json.loads(req.data.decode("utf-8"))
        return _FakeResp({"choices": [{"message": {"content": '{"label":"IC","confidence":1}'}}]})

    monkeypatch.setattr(labels_llm, "urlopen", fake_urlopen)
    labels_llm.call_llm(
        "http://h.local/v1", "gpt-test", "sk-secret", "sys", "user"
    )
    assert captured["url"].endswith("/chat/completions")
    # urllib lowercases header names in header_items()
    assert any(k.lower() == "authorization" and v == "Bearer sk-secret" for k, v in captured["headers"].items())
    assert captured["data"]["model"] == "gpt-test"
    assert captured["data"]["messages"][0]["role"] == "system"


def test_call_llm_omits_authorization_when_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        captured["headers"] = dict(req.header_items())
        return _FakeResp({"choices": [{"message": {"content": '{"label":"OOC","confidence":1}'}}]})

    monkeypatch.setattr(labels_llm, "urlopen", fake_urlopen)
    labels_llm.call_llm("http://h.local/v1", "m", "", "s", "u")
    assert not any(k.lower() == "authorization" for k in captured["headers"])


# ---- classify_messages end-to-end --------------------------------------


def test_classify_skips_messages_caught_by_rules(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # All three of these match a rule, so the LLM is never called.
    msgs = [
        _msg(1, ""),                    # rule:empty
        _msg(2, "ok thanks"),           # rule:short
        _msg(3, "(( afk )) " * 20),     # rule:parens
    ]
    fake, calls = _mk_urlopen([])
    monkeypatch.setattr(labels_llm, "urlopen", fake)
    conn = labels_store.connect(root=tmp_path)
    try:
        summary = labels_llm.classify_messages(
            "C", "P", msgs, _settings(), conn, concurrency=1
        )
    finally:
        conn.close()
    assert summary["classified"] == 0
    assert summary["total"] == 0
    assert summary["skipped_rule"] == 3
    assert calls == []  # no LLM calls happened


def test_classify_calls_llm_for_long_unlabeled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    long_text = "A" * 250
    msgs = [_msg(1, long_text)]
    fake, _ = _mk_urlopen(['{"label":"IC","confidence":0.85,"reason":"narrative"}'])
    monkeypatch.setattr(labels_llm, "urlopen", fake)
    conn = labels_store.connect(root=tmp_path)
    try:
        summary = labels_llm.classify_messages(
            "C", "P", msgs, _settings(), conn, concurrency=1
        )
        rows = labels_store.labels_for_partner(conn, "C", "P")
    finally:
        conn.close()
    assert summary["classified"] == 1
    assert summary["failed"] == 0
    assert len(rows) == 1
    only = next(iter(rows.values()))
    assert only["label"] == "IC"
    assert only["source"] == "llm"
    assert only["confidence"] == 0.85
    assert only["reason"] == "narrative"


def test_classify_progress_callback_fires(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    long = "A" * 250
    msgs = [_msg(i, long, speaker=f"P{i}") for i in range(1, 4)]
    fake, _ = _mk_urlopen([
        '{"label":"IC","confidence":0.9}',
        '{"label":"OOC","confidence":0.7}',
        '{"label":"IC","confidence":0.8}',
    ])
    monkeypatch.setattr(labels_llm, "urlopen", fake)
    events: list[dict] = []
    conn = labels_store.connect(root=tmp_path)
    try:
        labels_llm.classify_messages(
            "C", "P", msgs, _settings(), conn, concurrency=1,
            on_progress=lambda p: events.append(dict(p)),
        )
    finally:
        conn.close()
    # First emit is the pre-loop kick (classified=0). Then one per LLM call.
    assert len(events) == 4
    assert events[0]["classified"] == 0
    assert events[-1]["classified"] == 3


def test_classify_skips_already_labeled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    long = "A" * 250
    msgs = [_msg(1, long)]
    conn = labels_store.connect(root=tmp_path)
    try:
        # Pre-seed a manual label for this message.
        labels_store.upsert_label(
            conn,
            hash=labels_store.msg_hash(msgs[0]),
            character="C", partner="P", ts=1, speaker="Bob",
            label="OOC", source="manual",
        )
        fake, calls = _mk_urlopen([])  # nothing expected
        monkeypatch.setattr(labels_llm, "urlopen", fake)
        summary = labels_llm.classify_messages(
            "C", "P", msgs, _settings(), conn, concurrency=1
        )
    finally:
        conn.close()
    assert summary["classified"] == 0
    assert summary["skipped_existing"] == 1
    assert calls == []


def test_classify_records_failure_on_bad_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    long = "A" * 250
    msgs = [_msg(1, long)]
    fake, _ = _mk_urlopen(["not actually json"])
    monkeypatch.setattr(labels_llm, "urlopen", fake)
    conn = labels_store.connect(root=tmp_path)
    try:
        summary = labels_llm.classify_messages(
            "C", "P", msgs, _settings(), conn, concurrency=1
        )
    finally:
        conn.close()
    assert summary["classified"] == 0
    assert summary["failed"] == 1


def test_classify_honours_cancel_between_items(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    long = "A" * 250
    msgs = [_msg(i, long, speaker=f"P{i}") for i in range(1, 6)]
    # Trip cancel after the first response so item 2 onwards aren't called.
    cancel = threading.Event()
    call_count = {"n": 0}

    def fake(req, timeout=None):  # noqa: ARG001
        call_count["n"] += 1
        if call_count["n"] == 1:
            cancel.set()
        return _FakeResp({
            "choices": [{"message": {"content": '{"label":"IC","confidence":0.9}'}}]
        })

    monkeypatch.setattr(labels_llm, "urlopen", fake)
    conn = labels_store.connect(root=tmp_path)
    try:
        summary = labels_llm.classify_messages(
            "C", "P", msgs, _settings(), conn,
            concurrency=1, cancel=cancel,
        )
    finally:
        conn.close()
    # 1 classification went through, the rest were cancelled.
    assert call_count["n"] == 1
    assert summary["classified"] == 1
    assert summary["cancelled"] is True


# ---- job manager -------------------------------------------------------


@pytest.fixture
def isolated_registry(monkeypatch: pytest.MonkeyPatch) -> labels_jobs.JobRegistry:
    fresh = labels_jobs.JobRegistry()
    monkeypatch.setattr(labels_jobs, "_registry", fresh)
    monkeypatch.setattr(labels_jobs, "registry", lambda: fresh)
    return fresh


def _wait_until(predicate, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(f"predicate never held within {timeout}s")


def test_job_runs_single_partner_to_done(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, isolated_registry: labels_jobs.JobRegistry
) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))

    # Set up one character / one partner / one long message on disk.
    char_dir = tmp_path / "TestChar" / "logs"
    char_dir.mkdir(parents=True)
    long_text = "A" * 250
    # Use the real binary log writer would be overkill; monkeypatch
    # read_messages to return the message directly.
    msgs = [_msg(1700000000, long_text, speaker="Bob")]

    def fake_read_messages(char, partner, **_):  # noqa: ARG001
        return iter(msgs)

    monkeypatch.setattr(labels_jobs.logs_store, "read_messages", fake_read_messages)
    monkeypatch.setattr(
        labels_jobs,
        "_resolve_targets",
        lambda scope: [(scope["character"], scope["partner"])],
    )

    fake, _ = _mk_urlopen(['{"label":"IC","confidence":0.95}'])
    monkeypatch.setattr(labels_llm, "urlopen", fake)

    job = labels_jobs.start({"character": "TestChar", "partner": "Bob"})
    _wait_until(lambda: job.state in ("done", "failed", "cancelled"))
    assert job.state == "done"
    assert job.progress.classified == 1
    assert job.progress.failed == 0
    assert job.progress.total == 1
    assert job.finished_at is not None


def test_job_cancel_flips_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, isolated_registry: labels_jobs.JobRegistry
) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    long_text = "A" * 250
    msgs = [_msg(i, long_text, speaker=f"P{i}") for i in range(1, 6)]

    monkeypatch.setattr(labels_jobs.logs_store, "read_messages", lambda *_a, **_k: iter(msgs))
    monkeypatch.setattr(
        labels_jobs,
        "_resolve_targets",
        lambda scope: [(scope["character"], scope["partner"])],
    )

    started = threading.Event()
    proceed = threading.Event()

    def slow_urlopen(req, timeout=None):  # noqa: ARG001
        started.set()
        # Block briefly so the test gets a chance to cancel mid-run.
        proceed.wait(timeout=2.0)
        return _FakeResp({
            "choices": [{"message": {"content": '{"label":"IC","confidence":0.9}'}}]
        })

    monkeypatch.setattr(labels_llm, "urlopen", slow_urlopen)

    job = labels_jobs.start({"character": "TestChar", "partner": "P"})
    started.wait(timeout=2.0)
    assert isolated_registry.cancel(job.id) is True
    proceed.set()
    _wait_until(lambda: job.state in ("done", "cancelled", "failed"))
    assert job.state == "cancelled"


def test_registry_unknown_id_returns_none(isolated_registry: labels_jobs.JobRegistry) -> None:
    assert isolated_registry.get("does-not-exist") is None
    assert isolated_registry.cancel("does-not-exist") is False
