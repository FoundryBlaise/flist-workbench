"""Tier 2 working-copy CRUD + endpoint tests.

Covers character_archive.{read,write,delete}_working + working_etag +
the migration shim, plus the GET/PUT/DELETE /flist/character/{id}/
working endpoints — including the corrupt-file rename and the If-Match
optimistic-locking path.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient


# ---- fixtures ---------------------------------------------------------


def _seed_payload(**extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "_schema_version": 1,
        "_overlay": ["character.description"],
        "character": {"id": "123", "name": "Probe", "description": "[b]hi[/b]"},
    }
    payload.update(extra)
    return payload


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    from server import app

    return TestClient(app)


@pytest.fixture
def archive_module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    import importlib

    import character_archive

    importlib.reload(character_archive)
    return character_archive


# ---- character_archive module ----------------------------------------


def test_read_working_returns_none_when_missing(archive_module) -> None:
    assert archive_module.read_working("999") is None


def test_write_then_read_round_trips_payload(archive_module) -> None:
    payload = _seed_payload(infotags={"info_9": "Human"})
    etag = archive_module.write_working("123", payload)
    assert isinstance(etag, str) and len(etag) == 64
    out = archive_module.read_working("123")
    assert out is not None
    assert out["character"]["description"] == "[b]hi[/b]"
    assert out["infotags"] == {"info_9": "Human"}


def test_write_returns_etag_matching_disk_sha256(archive_module) -> None:
    payload = _seed_payload()
    etag = archive_module.write_working("123", payload)
    assert etag == archive_module.working_etag("123")


def test_write_with_matching_etag_succeeds(archive_module) -> None:
    payload = _seed_payload()
    first = archive_module.write_working("123", payload)
    payload["_overlay"] = ["character.description", "infotags.info_9"]
    payload.setdefault("infotags", {})["info_9"] = "Human"
    second = archive_module.write_working("123", payload, expected_etag=first)
    assert second != first


def test_write_with_stale_etag_raises_etag_mismatch(archive_module) -> None:
    payload = _seed_payload()
    archive_module.write_working("123", payload)
    with pytest.raises(archive_module.EtagMismatch) as info:
        archive_module.write_working("123", payload, expected_etag="0" * 64)
    assert info.value.current_etag is not None


def test_write_with_expected_etag_none_on_existing_file_raises(archive_module) -> None:
    payload = _seed_payload()
    archive_module.write_working("123", payload)
    # Passing expected_etag=None on an existing file is fine — first-write
    # path skips the mismatch check entirely. (Renderer always sends the
    # cached etag once it has one; None means "I expect no file yet".)
    archive_module.write_working("123", payload, expected_etag=None)


def test_delete_removes_file_returns_true(archive_module) -> None:
    archive_module.write_working("123", _seed_payload())
    assert archive_module.delete_working("123") is True
    assert archive_module.read_working("123") is None
    assert archive_module.delete_working("123") is False


def test_unknown_top_level_keys_preserved_round_trip(archive_module) -> None:
    """Forward-compat: future tiers can add keys without breaking older
    sidecars. Whole-payload write + raw read preserves anything."""
    payload = _seed_payload(_future_tier="opaque value", custom_kinks={})
    archive_module.write_working("123", payload)
    out = archive_module.read_working("123")
    assert out is not None
    assert out["_future_tier"] == "opaque value"


def test_corrupt_file_renamed_with_timestamp_suffix(archive_module) -> None:
    archive_module.write_working("123", _seed_payload())
    target = archive_module.working_path("123")
    target.write_text("{not json", encoding="utf-8")
    assert archive_module.read_working("123") is None
    quarantined = list(target.parent.glob("working.json.corrupt-*"))
    assert len(quarantined) == 1


def test_schema_version_missing_defaults_and_migrates(archive_module) -> None:
    """v1 file → migration shim stamps the current schema version and
    derives _custom_kinks_order when custom_kinks is present."""
    payload = {
        "_overlay": [],
        "character": {"id": "123"},
        "custom_kinks": {"42": {"name": "x"}},
    }
    archive_module.write_working("123", payload)
    out = archive_module.read_working("123")
    assert out is not None
    assert out["_schema_version"] == archive_module.WORKING_SCHEMA_VERSION
    assert out["_custom_kinks_order"] == ["42"]


def test_write_rejects_missing_overlay(archive_module) -> None:
    with pytest.raises(ValueError):
        archive_module.write_working("123", {"_schema_version": 1, "character": {}})


def test_write_rejects_empty_payload(archive_module) -> None:
    with pytest.raises(ValueError):
        archive_module.write_working("123", {"_schema_version": 1, "_overlay": []})


# ---- HTTP endpoints --------------------------------------------------


def test_get_working_404_when_missing(client: TestClient) -> None:
    assert client.get("/flist/character/999/working").status_code == 404


def test_put_then_get_round_trips_with_etag(client: TestClient) -> None:
    put = client.put(
        "/flist/character/123/working",
        json=_seed_payload(infotags={"info_9": "Human"}),
    )
    assert put.status_code == 200
    etag = put.json()["etag"]
    assert isinstance(etag, str) and len(etag) == 64
    got = client.get("/flist/character/123/working").json()
    assert got["etag"] == etag
    assert got["payload"]["infotags"] == {"info_9": "Human"}


def test_put_with_stale_if_match_returns_409_with_current_etag(
    client: TestClient,
) -> None:
    first = client.put(
        "/flist/character/123/working", json=_seed_payload()
    ).json()["etag"]
    res = client.put(
        "/flist/character/123/working",
        headers={"If-Match": "0" * 64},
        json=_seed_payload(infotags={"info_9": "Human"}),
    )
    assert res.status_code == 409
    body = res.json()
    detail = body["detail"]
    assert detail["detail"] == "etag_mismatch"
    assert detail["current_etag"] == first


def test_put_with_matching_if_match_succeeds(client: TestClient) -> None:
    first = client.put(
        "/flist/character/123/working", json=_seed_payload()
    ).json()["etag"]
    res = client.put(
        "/flist/character/123/working",
        headers={"If-Match": first},
        json=_seed_payload(infotags={"info_9": "Human"}),
    )
    assert res.status_code == 200
    assert res.json()["etag"] != first


def test_delete_endpoint_idempotent(client: TestClient) -> None:
    client.put("/flist/character/123/working", json=_seed_payload())
    res = client.delete("/flist/character/123/working")
    assert res.status_code == 200 and res.json()["deleted"] is True
    res = client.delete("/flist/character/123/working")
    assert res.status_code == 200 and res.json()["deleted"] is False


def test_put_rejects_invalid_payload(client: TestClient) -> None:
    res = client.put(
        "/flist/character/123/working",
        json={"_schema_version": 1, "_overlay": []},
    )
    assert res.status_code == 422


# ---- Tier 3: schema v2 (custom_kinks_order, tombstones, local: ids) ---


def test_tier2_v1_file_reads_as_v2_with_derived_order(archive_module) -> None:
    """A working.json written by a Tier 2 (v1) sidecar must read cleanly
    under Tier 3: the in-memory payload gets stamped v2 and the
    `_custom_kinks_order` array is derived from dict-insertion order
    so the rail renders without a fresh edit. Disk is *not* mutated on
    read — the on-disk file stays v1 until the next write."""
    target = archive_module.working_path("123")
    target.parent.mkdir(parents=True, exist_ok=True)
    import json as _json

    target.write_text(
        _json.dumps(
            {
                "_schema_version": 1,
                "_overlay": [],
                "custom_kinks": {
                    "31712021": {"name": "A", "choice": "fave", "children": []},
                    "31712022": {"name": "B", "choice": "yes", "children": []},
                },
            }
        ),
        encoding="utf-8",
    )
    out = archive_module.read_working("123")
    assert out is not None
    assert out["_schema_version"] == 2
    assert out["_custom_kinks_order"] == ["31712021", "31712022"]
    on_disk = _json.loads(target.read_text(encoding="utf-8"))
    assert on_disk["_schema_version"] == 1
    assert "_custom_kinks_order" not in on_disk


def test_custom_kinks_order_round_trip(archive_module) -> None:
    payload = _seed_payload(
        _custom_kinks_order=["31712021", "local:abc", "31712022"],
        custom_kinks={
            "31712021": {"name": "A", "choice": "fave", "children": []},
            "local:abc": {"name": "new", "choice": "undecided", "children": []},
            "31712022": {"name": "B", "choice": "yes", "children": []},
        },
    )
    archive_module.write_working("123", payload)
    out = archive_module.read_working("123")
    assert out is not None
    assert out["_custom_kinks_order"] == ["31712021", "local:abc", "31712022"]
    assert "local:abc" in out["custom_kinks"]


def test_tombstone_round_trip(archive_module) -> None:
    payload = _seed_payload(
        custom_kinks={
            "31712021": {
                "name": "X",
                "choice": "no",
                "children": [],
                "_deleted": True,
            }
        },
    )
    archive_module.write_working("123", payload)
    out = archive_module.read_working("123")
    assert out is not None
    assert out["custom_kinks"]["31712021"]["_deleted"] is True


def test_local_uuid_id_round_trip(archive_module) -> None:
    payload = _seed_payload(
        _custom_kinks_order=["local:b6c8c160-f70a-4e8f-9a4f-e60e90040703"],
        custom_kinks={
            "local:b6c8c160-f70a-4e8f-9a4f-e60e90040703": {
                "name": "Just-added",
                "description": "Not yet on F-list",
                "choice": "undecided",
                "children": [],
            }
        },
    )
    archive_module.write_working("123", payload)
    out = archive_module.read_working("123")
    assert out is not None
    key = "local:b6c8c160-f70a-4e8f-9a4f-e60e90040703"
    assert key in out["custom_kinks"]
    assert out["_custom_kinks_order"][0] == key


def test_atomic_write_unlinks_tmp_when_both_replaces_fail(
    archive_module, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the OneDrive-style retry also raises OSError, the leftover
    .tmp file must be cleaned up so the archive directory doesn't
    accumulate orphan temps. Round 1 verifier follow-up to QA P3-6."""
    fail_count = {"n": 0}
    orig_replace = Path.replace

    def fail_replace(self, target):  # type: ignore[override]
        fail_count["n"] += 1
        raise OSError("simulated lock")

    monkeypatch.setattr(Path, "replace", fail_replace)
    payload = _seed_payload()
    with pytest.raises(OSError):
        archive_module.write_working("123", payload)
    monkeypatch.setattr(Path, "replace", orig_replace)
    tmp = archive_module.working_path("123").with_suffix(".json.tmp")
    assert not tmp.exists()
    assert fail_count["n"] >= 2  # initial + at least one retry


def test_overlay_path_with_local_uuid_round_trips(archive_module) -> None:
    """The `local:<uuid>` id scheme uses `:` inside an overlay segment.
    Tier 3 §D-2 says no bespoke escaping — the writer must preserve the
    colon-bearing path verbatim on round-trip so the renderer's overlay
    membership lookup keeps working.
    """
    key = "local:b6c8c160-f70a-4e8f-9a4f-e60e90040703"
    payload = _seed_payload(
        _overlay=[
            f"custom_kinks.{key}.name",
            f"custom_kinks.{key}.choice",
            "custom_kinks._order",
        ],
        _custom_kinks_order=[key],
        custom_kinks={
            key: {
                "name": "Local-added",
                "description": "",
                "choice": "fave",
                "children": [],
            }
        },
    )
    archive_module.write_working("123", payload)
    out = archive_module.read_working("123")
    assert out is not None
    assert f"custom_kinks.{key}.name" in out["_overlay"]
    assert f"custom_kinks.{key}.choice" in out["_overlay"]
    assert key in out["custom_kinks"]


def test_tier3_writer_preserves_unknown_keys(archive_module) -> None:
    """Forward-compat invariant. A Tier 4+ key the reader doesn't know
    about must round-trip cleanly so a downgrade to Tier 3 doesn't
    silently lose data."""
    payload = _seed_payload(
        _future_pinned_tab="custom-kinks",
        _custom_kinks_order=[],
        custom_kinks={},
    )
    archive_module.write_working("123", payload)
    out = archive_module.read_working("123")
    assert out is not None
    assert out["_future_pinned_tab"] == "custom-kinks"
