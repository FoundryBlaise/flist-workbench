"""End-to-end tests for the AI-assistant draft store + accept pipeline.

These exercise the on-disk life cycle: create draft via append_edits,
verify pending shape, accept a subset, verify working.json reflects
the change and the draft is pruned, plus the etag-mismatch surface
on accept.

Network-free: a synthetic mapping list and working copy are written
to a temp dir; no F-list calls.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest


MAPPING_LIST: dict[str, Any] = {
    "infotags": {
        "49": {
            "id": 49,
            "name": "Language preferences",
            "type": "list",
            "list": [
                {"id": 21, "name": "English"},
                {"id": 22, "name": "German"},
            ],
        },
        "1": {"id": 1, "name": "Height", "type": "text"},
    },
    "kinks": [
        {"id": 100, "name": "k100"},
        {"id": 200, "name": "k200"},
    ],
}


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    # Force a fresh import so any cached path resolution sees the env.
    import importlib

    for mod in ("paths", "character_archive", "ai_draft"):
        if mod in __import__("sys").modules:
            importlib.reload(__import__("sys").modules[mod])
    return tmp_path / "wb"


def _seed_character(character_id: str = "42") -> None:
    """Write a synthetic working.json so the draft has something to
    anchor against. Matches the v6 shape produced by
    `_seed_payload_from_live` plus a sensible mix of editable fields."""
    import character_archive

    working = {
        "_schema_version": character_archive.WORKING_SCHEMA_VERSION,
        "_overlay": [],
        "character": {
            "id": int(character_id),
            "name": "Test Char",
            "description": "Hello [b]world[/b].\nLine two.",
        },
        "infotags": {"49": "21"},
        "settings": {"public": True},
        "kinks": {"100": "yes"},
        "custom_kinks": {"a1": {"name": "Strap", "description": "", "choice": "yes"}},
        "_custom_kinks_order": ["a1"],
        "images": [{"image_id": "img-1", "description": "", "sort_order": 0}],
    }
    character_archive.write_working(character_id, working)


def test_no_working_copy_returns_all_rejected(env: Path) -> None:
    import ai_draft

    edits = [
        {
            "tool": "set_infotag",
            "field_path": "infotags.49",
            "new_value": "German",
            "rationale": "test",
        }
    ]
    result = ai_draft.append_edits("42", edits, MAPPING_LIST)
    assert result["draft"] is None
    assert len(result["rejected"]) == 1
    assert result["rejected"][0]["reason"] == "no_working_copy"


def test_append_then_accept_set_infotag(env: Path) -> None:
    import ai_draft
    import character_archive

    _seed_character("42")
    initial_etag = character_archive.working_etag("42")

    edits = [
        {
            "tool": "set_infotag",
            "field_path": "infotags.49",
            "new_value": "German",
            "rationale": "language change",
        }
    ]
    result = ai_draft.append_edits("42", edits, MAPPING_LIST)
    assert result["draft"] is not None
    assert len(result["accepted_edit_ids"]) == 1
    edit_id = result["accepted_edit_ids"][0]
    assert result["draft"]["base_etag"] == initial_etag

    accept = ai_draft.accept_edits("42", [edit_id], initial_etag)
    assert accept["applied_edit_ids"] == [edit_id]
    assert accept["new_etag"] != initial_etag
    assert accept["draft"] is None  # last pending edit consumed → draft deleted

    working = character_archive.read_working("42")
    assert working["infotags"]["49"] == "22"  # resolved to German's listitem
    assert "infotags.49" in working["_overlay"]


def test_accept_with_stale_etag_raises(env: Path) -> None:
    import ai_draft
    import character_archive

    _seed_character("42")
    edits = [
        {
            "tool": "set_infotag",
            "field_path": "infotags.49",
            "new_value": "German",
            "rationale": "x",
        }
    ]
    result = ai_draft.append_edits("42", edits, MAPPING_LIST)
    edit_id = result["accepted_edit_ids"][0]

    with pytest.raises(character_archive.EtagMismatch):
        ai_draft.accept_edits("42", [edit_id], "not-the-real-etag")

    # Draft survives the failure.
    assert ai_draft.read_draft("42") is not None


def test_append_marks_stale_when_working_moved_under_draft(
    env: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the user (or another window) edits the working copy between
    two append_edits calls, the second batch should be marked `stale`
    rather than silently treated as anchored on the moved text."""
    import ai_draft
    import character_archive

    _seed_character("42")

    # First batch — establishes base_etag.
    first = ai_draft.append_edits(
        "42",
        [
            {
                "tool": "set_infotag",
                "field_path": "infotags.49",
                "new_value": "German",
                "rationale": "round 1",
            }
        ],
        MAPPING_LIST,
    )
    assert first["draft"]["edits"][0]["status"] == "pending"

    # Simulate a manual edit elsewhere (touches description directly).
    w = character_archive.read_working("42")
    w["character"]["description"] = "user typed something new"
    character_archive.write_working("42", w)

    # Second batch — draft.base_etag now != current working etag.
    second = ai_draft.append_edits(
        "42",
        [
            {
                "tool": "set_infotag",
                "field_path": "infotags.49",
                "new_value": "English",
                "rationale": "round 2",
            }
        ],
        MAPPING_LIST,
    )
    statuses = [e["status"] for e in second["draft"]["edits"]]
    # Both edits get re-stamped stale on the next append because we
    # recompute the staleness from current vs base_etag.
    assert statuses[-1] == "stale"


def test_reject_edits_prunes_from_draft(env: Path) -> None:
    import ai_draft

    _seed_character("42")
    result = ai_draft.append_edits(
        "42",
        [
            {
                "tool": "set_infotag",
                "field_path": "infotags.49",
                "new_value": "German",
                "rationale": "a",
            },
            {
                "tool": "replace_description",
                "field_path": "character.description",
                "new_value": "Rewritten body",
                "rationale": "b",
            },
        ],
        MAPPING_LIST,
    )
    [first, second] = result["accepted_edit_ids"]
    updated = ai_draft.reject_edits("42", [first])
    assert updated is not None
    remaining_ids = [e["id"] for e in updated["edits"]]
    assert first not in remaining_ids
    assert second in remaining_ids


def test_reject_last_edit_deletes_draft_file(env: Path) -> None:
    import ai_draft

    _seed_character("42")
    result = ai_draft.append_edits(
        "42",
        [
            {
                "tool": "set_infotag",
                "field_path": "infotags.49",
                "new_value": "German",
                "rationale": "only one",
            },
        ],
        MAPPING_LIST,
    )
    only_id = result["accepted_edit_ids"][0]
    ai_draft.reject_edits("42", [only_id])
    assert ai_draft.read_draft("42") is None


def test_accept_subset_keeps_other_edits_in_draft(env: Path) -> None:
    import ai_draft
    import character_archive

    _seed_character("42")
    etag = character_archive.working_etag("42")
    result = ai_draft.append_edits(
        "42",
        [
            {
                "tool": "set_infotag",
                "field_path": "infotags.49",
                "new_value": "German",
                "rationale": "1",
            },
            {
                "tool": "replace_description",
                "field_path": "character.description",
                "new_value": "Fresh body text",
                "rationale": "2",
            },
        ],
        MAPPING_LIST,
    )
    [first, second] = result["accepted_edit_ids"]
    accept = ai_draft.accept_edits("42", [first], etag)
    assert accept["draft"] is not None
    remaining_ids = [e["id"] for e in accept["draft"]["edits"]]
    assert second in remaining_ids
    assert first not in remaining_ids


def test_apply_replace_description(env: Path) -> None:
    import ai_draft
    import character_archive

    _seed_character("42")
    etag = character_archive.working_etag("42")
    result = ai_draft.append_edits(
        "42",
        [
            {
                "tool": "replace_description",
                "field_path": "character.description",
                "new_value": "Rewritten body.",
                "rationale": "tighten",
            }
        ],
        MAPPING_LIST,
    )
    edit_id = result["accepted_edit_ids"][0]
    ai_draft.accept_edits("42", [edit_id], etag)
    working = character_archive.read_working("42")
    assert working["character"]["description"] == "Rewritten body."
    assert "character.description" in working["_overlay"]


def test_apply_set_standard_kink(env: Path) -> None:
    import ai_draft
    import character_archive

    _seed_character("42")
    etag = character_archive.working_etag("42")
    result = ai_draft.append_edits(
        "42",
        [
            {
                "tool": "set_standard_kink",
                "field_path": "kinks.100",
                "new_value": "fave",
                "rationale": "promote",
            },
            {
                "tool": "set_standard_kink",
                "field_path": "kinks.200",
                "new_value": "no",
                "rationale": "demote",
            },
        ],
        MAPPING_LIST,
    )
    ids = result["accepted_edit_ids"]
    ai_draft.accept_edits("42", ids, etag)
    working = character_archive.read_working("42")
    assert working["kinks"]["100"] == "fave"
    assert working["kinks"]["200"] == "no"


def test_apply_add_image_to_gallery(env: Path) -> None:
    import ai_draft
    import character_archive

    _seed_character("42")
    # Validator now refuses image_ids that aren't on disk to keep the
    # model from inventing ids that lead to broken thumbnails. Drop a
    # stub file so this happy-path test still exercises the apply step.
    images_dir = character_archive.images_dir("42")
    images_dir.mkdir(parents=True, exist_ok=True)
    (images_dir / "img-new.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    etag = character_archive.working_etag("42")
    result = ai_draft.append_edits(
        "42",
        [
            {
                "tool": "add_image_to_gallery",
                "field_path": "images",
                "new_value": "img-new",
                "rationale": "add to gallery",
            }
        ],
        MAPPING_LIST,
    )
    edit_id = result["accepted_edit_ids"][0]
    ai_draft.accept_edits("42", [edit_id], etag)
    working = character_archive.read_working("42")
    ids = [e["image_id"] for e in working["images"]]
    assert "img-new" in ids
    assert "images" in working["_overlay"]


def test_edit_ids_stay_monotonic_after_reject(env: Path) -> None:
    """The next_edit_seq counter must NOT roll back when an earlier edit
    is rejected — otherwise the next append re-uses the rejected id and
    accept/reject by id becomes ambiguous (QA P0 finding 2026-06-19)."""
    import ai_draft

    _seed_character("42")
    first = ai_draft.append_edits(
        "42",
        [
            {"tool": "set_infotag", "field_path": "infotags.49",
             "new_value": "German", "rationale": "a"},
            {"tool": "set_infotag", "field_path": "infotags.49",
             "new_value": "English", "rationale": "b"},
        ],
        MAPPING_LIST,
    )
    ids_round_one = first["accepted_edit_ids"]
    assert ids_round_one == ["edit-001", "edit-002"]

    # Reject the second one then append a new edit. The new id should
    # be edit-003, not edit-002 (which would collide had we ever
    # re-used it from a counted-from-list-length scheme).
    ai_draft.reject_edits("42", ["edit-002"])
    second = ai_draft.append_edits(
        "42",
        [
            {"tool": "set_infotag", "field_path": "infotags.49",
             "new_value": "German", "rationale": "c"},
        ],
        MAPPING_LIST,
    )
    assert second["accepted_edit_ids"] == ["edit-003"]


def test_accept_skips_stale_edits(env: Path) -> None:
    """Stale edits stay in the draft on a partial accept; the response
    flags them in `skipped_stale`. Earlier the accept path would apply
    a stale edit against the newer working baseline silently."""
    import ai_draft
    import character_archive

    _seed_character("42")
    first = ai_draft.append_edits(
        "42",
        [
            {"tool": "set_infotag", "field_path": "infotags.49",
             "new_value": "German", "rationale": "round 1"},
        ],
        MAPPING_LIST,
    )
    first_id = first["accepted_edit_ids"][0]

    # Move the working copy so the second append becomes stale.
    w = character_archive.read_working("42")
    w["character"]["description"] = "external edit"
    character_archive.write_working("42", w)

    # Second append against the stale base must be REJECTED entirely
    # (not silently persisted as stale) so the model gets a clear
    # tool-result it can react to.
    second = ai_draft.append_edits(
        "42",
        [
            {"tool": "set_infotag", "field_path": "infotags.49",
             "new_value": "English", "rationale": "round 2"},
        ],
        MAPPING_LIST,
    )
    assert second["accepted_edit_ids"] == []
    assert second["rejected"][0]["reason"] == "stale_base"
    # The original first edit was re-stamped stale.
    assert all(e["status"] == "stale" for e in second["draft"]["edits"])
    assert {e["id"] for e in second["draft"]["edits"]} == {first_id}

    new_etag = character_archive.working_etag("42")
    result = ai_draft.accept_edits("42", [first_id], new_etag)
    assert result["applied_edit_ids"] == []
    assert set(result["skipped_stale"]) == {first_id}


def test_draft_size_cap_rejects_overflow(env: Path) -> None:
    """Appending past MAX_EDITS_PER_DRAFT must return rejection
    envelopes rather than silently growing the journal. Guards a
    runaway tool loop from inflating the file to thousands of rows."""
    import ai_draft

    _seed_character("42")
    # Build past the cap. Use set_infotag because it always validates
    # cleanly; the overflow is what we're exercising, not validation.
    edits = [
        {
            "tool": "set_infotag",
            "field_path": "infotags.49",
            "new_value": "German",
            "rationale": f"n={i}",
        }
        for i in range(ai_draft.MAX_EDITS_PER_DRAFT + 5)
    ]
    result = ai_draft.append_edits("42", edits, MAPPING_LIST)
    assert len(result["accepted_edit_ids"]) == ai_draft.MAX_EDITS_PER_DRAFT
    overflow_reasons = [r["reason"] for r in result["rejected"]]
    assert overflow_reasons.count("draft_full") == 5


def test_add_image_rejected_when_bytes_missing(env: Path) -> None:
    import ai_draft

    _seed_character("42")
    result = ai_draft.append_edits(
        "42",
        [
            {
                "tool": "add_image_to_gallery",
                "field_path": "images",
                "new_value": "fictional-id",
                "rationale": "model invented this",
            }
        ],
        MAPPING_LIST,
    )
    assert result["accepted_edit_ids"] == []
    assert result["rejected"][0]["reason"] == "unknown_image"


def test_apply_remove_image_from_gallery_keeps_other(env: Path) -> None:
    import ai_draft
    import character_archive

    _seed_character("42")
    # Add a second image first so we can verify the remove targets only one.
    w = character_archive.read_working("42")
    w["images"].append({"image_id": "img-2", "description": "", "sort_order": 1})
    character_archive.write_working("42", w)
    etag = character_archive.working_etag("42")
    result = ai_draft.append_edits(
        "42",
        [
            {
                "tool": "remove_image_from_gallery",
                "field_path": "images",
                "old_value": "img-1",
                "rationale": "drop oldest",
            }
        ],
        MAPPING_LIST,
    )
    edit_id = result["accepted_edit_ids"][0]
    ai_draft.accept_edits("42", [edit_id], etag)
    working = character_archive.read_working("42")
    ids = [e["image_id"] for e in working["images"]]
    assert ids == ["img-2"]


def test_apply_add_custom_kink_assigns_negative_id(env: Path) -> None:
    import ai_draft
    import character_archive

    _seed_character("42")
    etag = character_archive.working_etag("42")
    result = ai_draft.append_edits(
        "42",
        [
            {
                "tool": "add_custom_kink",
                "field_path": "custom_kinks",
                "new_value": {"name": "Brand new", "description": "", "choice": "fave"},
                "rationale": "expand",
            }
        ],
        MAPPING_LIST,
    )
    edit_id = result["accepted_edit_ids"][0]
    ai_draft.accept_edits("42", [edit_id], etag)
    working = character_archive.read_working("42")
    new_ids = [k for k in working["custom_kinks"].keys() if k.startswith("-")]
    assert new_ids, "expected at least one negative-id custom kink"
    assert working["custom_kinks"][new_ids[0]]["name"] == "Brand new"
