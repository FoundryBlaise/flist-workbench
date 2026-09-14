"""Taking on the ids F-list gave our own uploads.

An image uploaded here is keyed by a hash of its bytes — it has no
F-list id yet. After the extension uploads it, F-list mints one, and
until the archive learns it the two sides cannot recognise the same
picture: a restore deletes the whole gallery and re-uploads it, and a
pull leaves a byte-identical twin on disk under the other name. The
user saw both — 17 deleted and 16 re-uploaded to change one picture,
and 33 files where 17 belong.
"""

from __future__ import annotations

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


PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def _with_gallery(archive, *image_ids: str) -> str:
    bench = archive.resolve_workbench("42")
    archive.write_set_payload(
        "42",
        bench.id,
        {
            "_schema_version": archive.WORKING_SCHEMA_VERSION,
            "_overlay": ["images"],
            "character": {"description": "x"},
            "images": [
                {"image_id": i, "description": "", "sort_order": n}
                for n, i in enumerate(image_ids)
            ],
        },
        expected_etag=None,
    )
    return bench.id


def _gallery(archive, set_id: str) -> list[str]:
    payload = archive.read_set_payload("42", set_id) or {}
    return [row["image_id"] for row in payload.get("images", [])]


def test_the_gallery_moves_to_the_f_list_id(archive) -> None:
    row = archive.add_uploaded_image("42", PNG)
    local_id = row["image_id"]
    set_id = _with_gallery(archive, local_id)

    result = archive.adopt_flist_image_ids("42", {local_id: "47000849"})

    assert _gallery(archive, set_id) == ["47000849"]
    assert result["sets_rewritten"] == 1
    assert result["renamed"] == [{"from": local_id, "to": "47000849"}]


def test_the_file_is_renamed_with_it(archive) -> None:
    row = archive.add_uploaded_image("42", PNG)
    local_id = row["image_id"]
    _with_gallery(archive, local_id)
    images = archive.images_dir("42")

    archive.adopt_flist_image_ids("42", {local_id: "47000849"})

    assert (images / "47000849.png").exists()
    assert not (images / f"{local_id}.png").exists()


def test_a_twin_left_by_a_pull_is_dropped(archive) -> None:
    # The pull fetched the same picture under its F-list name; keeping
    # both is what filled the user's archive with 16 duplicate pairs.
    row = archive.add_uploaded_image("42", PNG)
    local_id = row["image_id"]
    _with_gallery(archive, local_id)
    images = archive.images_dir("42")
    (images / "47000849.png").write_bytes(PNG)

    result = archive.adopt_flist_image_ids("42", {local_id: "47000849"})

    assert not (images / f"{local_id}.png").exists()
    assert (images / "47000849.png").read_bytes() == PNG
    assert result["dropped_duplicate"] == [local_id]


def test_running_it_twice_changes_nothing_further(archive) -> None:
    row = archive.add_uploaded_image("42", PNG)
    local_id = row["image_id"]
    set_id = _with_gallery(archive, local_id)

    archive.adopt_flist_image_ids("42", {local_id: "47000849"})
    second = archive.adopt_flist_image_ids("42", {local_id: "47000849"})

    assert _gallery(archive, set_id) == ["47000849"]
    assert second["renamed"] == []
    assert second["unknown"] == [local_id]


def test_ids_that_are_not_ours_to_move_are_reported(archive) -> None:
    result = archive.adopt_flist_image_ids(
        "42", {"47000849": "47000850", "local-deadbeef": "..unsafe"}
    )
    assert result["renamed"] == []
    assert sorted(result["unknown"]) == ["47000849", "local-deadbeef"]


def test_it_leaves_images_it_was_not_told_about_alone(archive) -> None:
    keep = archive.add_uploaded_image("42", PNG)["image_id"]
    other = archive.add_uploaded_image("42", PNG + b"different")["image_id"]
    set_id = _with_gallery(archive, keep, other)

    archive.adopt_flist_image_ids("42", {keep: "47000849"})

    assert _gallery(archive, set_id) == ["47000849", other]
