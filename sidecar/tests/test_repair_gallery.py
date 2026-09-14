"""Putting a gallery back together after its entries lost their bytes.

A slot pointing at bytes that are gone renders as a black placeholder,
and — worse — vanishes from the restore ZIP, which the extension reads
as "delete this from the profile". The user lost images on f-list.net
that way. Repair runs on its own when the Images tab opens, so nobody
has to know the word "sha8" to get their pictures back.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest


@pytest.fixture
def archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    import importlib

    import character_archive

    importlib.reload(character_archive)
    character_archive.register_character("42", "Lady Amber Blaise")
    character_archive.write_live(
        "42",
        {
            "character": {"id": 42, "name": "Lady Amber Blaise", "description": "x"},
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1000,
        },
    )
    return character_archive


def png(seed: bytes) -> bytes:
    return b"\x89PNG\r\n\x1a\n" + seed * 16


def local_id_for(data: bytes) -> str:
    return f"local-{hashlib.sha256(data).hexdigest()[:8]}"


def set_gallery(archive, *image_ids: str) -> str:
    bench = archive.resolve_workbench("42")
    archive.write_set_payload(
        "42",
        bench.id,
        {
            "_schema_version": archive.WORKING_SCHEMA_VERSION,
            "_overlay": ["images"],
            "character": {"description": "x"},
            "images": [
                {"image_id": i, "description": f"slot {n}", "sort_order": n}
                for n, i in enumerate(image_ids)
            ],
        },
        expected_etag=None,
    )
    return bench.id


def gallery(archive, set_id: str) -> list[str]:
    payload = archive.read_set_payload("42", set_id) or {}
    return [row["image_id"] for row in payload.get("images", [])]


def test_a_dead_local_entry_is_relinked_to_the_same_bytes(archive) -> None:
    # The picture is on disk under the id F-list gave it; the gallery
    # still points at the local name, whose file is gone. The local id
    # carries the hash, so the two can be matched without downloading
    # anything or asking the user.
    data = png(b"a")
    archive.write_character_image("42", "46992674", "png", data)
    set_id = set_gallery(archive, local_id_for(data))

    result = archive.repair_gallery("42")

    assert gallery(archive, set_id) == ["46992674"]
    assert result["relinked"] == [
        {"from": local_id_for(data), "to": "46992674"}
    ]
    assert result["repaired"] is True


def test_the_slot_keeps_its_place_and_description(archive) -> None:
    first, second = png(b"a"), png(b"b")
    archive.write_character_image("42", "46992674", "png", first)
    archive.write_character_image("42", "46992670", "png", second)
    set_id = set_gallery(archive, local_id_for(first), local_id_for(second))

    archive.repair_gallery("42")

    payload = archive.read_set_payload("42", set_id) or {}
    assert [(r["image_id"], r["description"]) for r in payload["images"]] == [
        ("46992674", "slot 0"),
        ("46992670", "slot 1"),
    ]


def test_the_same_picture_cannot_hold_three_slots(archive) -> None:
    # Seen in the field: one image filling positions 8, 9 and 10 while
    # the pictures that belonged there sat in the pool.
    data = png(b"a")
    archive.write_character_image("42", "47002195", "png", data)
    set_id = set_gallery(archive, "47002195", "47002195", "47002195")

    result = archive.repair_gallery("42")

    assert gallery(archive, set_id) == ["47002195"]
    assert result["duplicates_removed"] == ["47002195", "47002195"]


def test_an_entry_it_cannot_resolve_is_reported_not_deleted(archive) -> None:
    # No file, no hash to match: dropping it would throw away the slot
    # order on a hunch. Say so and leave it.
    set_id = set_gallery(archive, "99999999")

    result = archive.repair_gallery("42")

    assert gallery(archive, set_id) == ["99999999"]
    assert result["unresolved"] == ["99999999"]
    assert result["repaired"] is False


def test_a_healthy_gallery_is_left_alone(archive) -> None:
    data = png(b"a")
    archive.write_character_image("42", "46992674", "png", data)
    set_id = set_gallery(archive, "46992674")

    result = archive.repair_gallery("42")

    assert gallery(archive, set_id) == ["46992674"]
    assert result["repaired"] is False
    assert result["sets_rewritten"] == 0


def test_running_it_again_finds_nothing_left_to_do(archive) -> None:
    data = png(b"a")
    archive.write_character_image("42", "46992674", "png", data)
    set_gallery(archive, local_id_for(data))

    archive.repair_gallery("42")
    second = archive.repair_gallery("42")

    assert second["repaired"] is False
    assert second["relinked"] == []


def test_a_local_image_that_still_has_its_file_is_untouched(archive) -> None:
    # Not every local id is broken — an upload that has never been
    # pushed to F-list is perfectly normal.
    data = png(b"c")
    row = archive.add_uploaded_image("42", data)
    set_id = set_gallery(archive, row["image_id"])

    result = archive.repair_gallery("42")

    assert gallery(archive, set_id) == [row["image_id"]]
    assert result["repaired"] is False


# ---- ids that a re-upload replaced --------------------------------------


def live_with(archive, *image_ids: str) -> None:
    archive.write_live(
        "42",
        {
            "character": {"id": 42, "name": "Lady Amber Blaise", "description": "x"},
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [{"image_id": i} for i in image_ids],
            "fetched_at": 1000,
        },
    )


def test_a_slot_follows_its_bytes_to_the_new_id(archive) -> None:
    """Reported from the field: after synchronising, the same picture
    was in the pool and on the profile at once.

    The extension deletes and re-uploads a gallery, and F-list mints a
    new id for each image. The working set still names the old ones —
    which the site no longer has — while the bytes it pulled back sit
    in the pool under the new id. Both ids have files here, so the
    "entry lost its bytes" rule does not see it; what marks the old id
    as dead is that Live no longer lists it.
    """
    data = png(b"a")
    archive.write_character_image("42", "46992661", "png", data)
    archive.write_character_image("42", "47002719", "png", data)
    live_with(archive, "47002719")
    set_id = set_gallery(archive, "46992661")

    result = archive.repair_gallery("42")

    assert gallery(archive, set_id) == ["47002719"]
    assert result["relinked"] == [{"from": "46992661", "to": "47002719"}]
    # The leftover file would otherwise sit in the pool for good.
    assert result["stale_removed"] == ["46992661"]
    assert not (archive.images_dir("42") / "46992661.png").exists()


def test_an_id_live_still_lists_is_left_alone(archive) -> None:
    # F-list can hold the same picture twice. When it still knows the
    # id in the gallery, that slot is correct and nothing is stale.
    data = png(b"a")
    archive.write_character_image("42", "47002195", "png", data)
    archive.write_character_image("42", "47002721", "png", data)
    live_with(archive, "47002195", "47002721")
    set_id = set_gallery(archive, "47002195")

    result = archive.repair_gallery("42")

    assert gallery(archive, set_id) == ["47002195"]
    assert result["repaired"] is False
    assert (archive.images_dir("42") / "47002195.png").exists()


def test_without_a_pull_nothing_is_assumed(archive) -> None:
    # An empty Live means "we have not looked", not "the profile is
    # empty". Treating it as evidence would delete the user's images.
    data = png(b"a")
    archive.write_character_image("42", "46992661", "png", data)
    archive.write_character_image("42", "47002719", "png", data)
    set_id = set_gallery(archive, "46992661")

    result = archive.repair_gallery("42")

    assert gallery(archive, set_id) == ["46992661"]
    assert result["repaired"] is False
    assert (archive.images_dir("42") / "46992661.png").exists()


def test_a_local_upload_not_yet_on_f_list_survives(archive) -> None:
    # Not in Live and no twin that is — perfectly normal for something
    # the user has not pushed yet.
    row = archive.add_uploaded_image("42", png(b"fresh"))
    live_with(archive, "47002719")
    archive.write_character_image("42", "47002719", "png", png(b"other"))
    set_id = set_gallery(archive, row["image_id"])

    result = archive.repair_gallery("42")

    assert gallery(archive, set_id) == [row["image_id"]]
    assert result["repaired"] is False
