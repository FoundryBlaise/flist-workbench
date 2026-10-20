"""Importing image files into a character's pool over MCP.

The case this exists for: a model edited 39 profile pictures outside the
Workbench and had to put them back. That took the user copying files by
hand, the model matching hashes to find the new ids, and about 75 tool
calls of add/remove/reorder. These tests hold the one-call version to
what the user asked for, including the parts that keep a model inside
the folders the user cleared.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from mcp_helpers import call_tool, mcp_client, tool_error_text
from test_mcp_edit import make_draft, payload_of, seed_gallery, workbench  # noqa: F401

CHAR = "Lady Amber Blaise"


def png_bytes(size: tuple[int, int], color=(200, 40, 40), **save: Any) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, "PNG", **save)
    return out.getvalue()


def jpeg_bytes(size: tuple[int, int], color=(10, 120, 200)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, "JPEG", quality=90)
    return out.getvalue()


def gradient_png(size: tuple[int, int], *, alpha: int | None = None) -> bytes:
    """An uncompressed PNG: large on disk, tiny as a JPEG."""
    width, height = size
    img = Image.new("RGBA" if alpha is not None else "RGB", size)
    px = img.load()
    for x in range(width):
        for y in range(height):
            rgb = (x * 255 // width, y * 255 // height, 128)
            px[x, y] = rgb + ((alpha,) if alpha is not None else ())
    out = io.BytesIO()
    img.save(out, "PNG", compress_level=0)
    return out.getvalue()


@pytest.fixture
def outputs(tmp_path: Path, workbench) -> Path:  # noqa: F811
    """A folder the user has cleared for import."""
    import settings as settings_store
    from services import image_import

    folder = tmp_path / "Outputs"
    folder.mkdir()
    conn = settings_store.connect()
    try:
        image_import.save_import_roots(conn, [str(folder)])
    finally:
        conn.close()
    return folder


def pool_files(archive) -> set[str]:
    return {p.name for p in archive.images_dir("42").iterdir() if p.is_file()}


def put_on_disk(archive, image_id: str, data: bytes, ext: str = "jpg") -> None:
    archive.write_character_image("42", image_id, ext, data)


# --------------------------------------------------------------------
# Into the pool
# --------------------------------------------------------------------


async def test_a_file_lands_in_the_pool_and_is_stored_once(workbench, outputs) -> None:  # noqa: F811
    src = outputs / "46124192.jpg"
    src.write_bytes(jpeg_bytes((64, 96)))

    async with mcp_client("character") as session:
        _, first = await call_tool(
            session, "import_image", character=CHAR, source_path=str(src)
        )
        _, second = await call_tool(
            session, "import_image", character=CHAR, source_path=str(src)
        )

    assert first["image_id"].startswith("local-")
    assert first["deduplicated"] is False
    assert (first["extension"], first["width"], first["height"]) == ("jpg", 64, 96)
    assert first["source_name"] == "46124192.jpg"
    assert first["on_profile"] is False
    assert first["warnings"] == []
    assert second["image_id"] == first["image_id"]
    assert second["deduplicated"] is True
    assert pool_files(workbench) == {f"{first['image_id']}.jpg"}
    # Copied, never moved.
    assert src.exists()


async def test_a_file_already_pulled_from_f_list_keeps_its_f_list_id(
    workbench, outputs  # noqa: F811
) -> None:
    data = jpeg_bytes((32, 32))
    put_on_disk(workbench, "47000849", data)
    src = outputs / "copy.jpg"
    src.write_bytes(data)

    async with mcp_client("character") as session:
        _, body = await call_tool(
            session, "import_image", character=CHAR, source_path=str(src)
        )

    assert body["image_id"] == "47000849"
    assert body["deduplicated"] is True
    assert pool_files(workbench) == {"47000849.jpg"}


async def test_the_format_is_judged_by_content_not_name(workbench, outputs) -> None:  # noqa: F811
    disguised = outputs / "really_a_png.jpg"
    disguised.write_bytes(png_bytes((8, 8)))
    text = outputs / "notes.png"
    text.write_text("not an image", encoding="utf-8")

    async with mcp_client("character") as session:
        _, body = await call_tool(
            session, "import_image", character=CHAR, source_path=str(disguised)
        )
        refused, _ = await call_tool(
            session, "import_image", character=CHAR, source_path=str(text)
        )

    assert body["extension"] == "png"
    assert "not_an_image" in tool_error_text(refused)


# --------------------------------------------------------------------
# Only from cleared folders
# --------------------------------------------------------------------


async def test_a_path_outside_the_cleared_folders_is_refused(
    workbench, outputs, tmp_path: Path  # noqa: F811
) -> None:
    elsewhere = tmp_path / "Private"
    elsewhere.mkdir()
    secret = elsewhere / "secret.png"
    secret.write_bytes(png_bytes((8, 8)))
    # `..` must not walk out of a cleared folder either.
    sneaky = outputs / ".." / "Private" / "secret.png"

    async with mcp_client("character") as session:
        direct, _ = await call_tool(
            session, "import_image", character=CHAR, source_path=str(secret)
        )
        dotdot, _ = await call_tool(
            session, "import_image", character=CHAR, source_path=str(sneaky)
        )
        relative, _ = await call_tool(
            session, "import_image", character=CHAR, source_path="secret.png"
        )

    assert "source_not_allowed" in tool_error_text(direct)
    # The refusal lists the cleared folders (JSON-escaped in the details).
    assert str(outputs).replace("\\", "\\\\") in tool_error_text(direct)
    assert "source_not_allowed" in tool_error_text(dotdot)
    assert "source_path_not_absolute" in tool_error_text(relative)
    assert pool_files(workbench) == set()


async def test_outside_a_cleared_folder_existence_is_not_revealed(
    workbench, outputs, tmp_path: Path  # noqa: F811
) -> None:
    async with mcp_client("character") as session:
        missing, _ = await call_tool(
            session,
            "import_image",
            character=CHAR,
            source_path=str(tmp_path / "nowhere" / "x.png"),
        )
    assert "source_not_allowed" in tool_error_text(missing)


async def test_with_no_cleared_folders_nothing_can_be_imported(
    workbench, tmp_path: Path  # noqa: F811
) -> None:
    src = tmp_path / "a.png"
    src.write_bytes(png_bytes((8, 8)))
    async with mcp_client("character") as session:
        result, _ = await call_tool(
            session, "import_image", character=CHAR, source_path=str(src)
        )
    text = tool_error_text(result)
    assert "no_import_folders" in text
    assert "Settings" in text


async def test_a_model_can_read_the_folders_but_not_change_them(
    workbench, outputs  # noqa: F811
) -> None:
    async with mcp_client() as session:
        _, current = await call_tool(session, "get_settings")
        tools = (await session.list_tools()).tools

    assert current["image_import_folders"] == [str(outputs)]
    update = next(t for t in tools if t.name == "update_settings")
    params = set(update.inputSchema.get("properties", {}))
    assert not any("import" in p or "folder" in p for p in params), params


def test_the_window_validates_the_folders_it_saves(workbench, tmp_path: Path) -> None:  # noqa: F811
    from fastapi.testclient import TestClient

    import server

    real = tmp_path / "Outputs"
    real.mkdir()
    with TestClient(server.app) as client:
        bad = client.put(
            "/settings", json={"image_import_roots": [str(tmp_path / "missing")]}
        )
        good = client.put("/settings", json={"image_import_roots": [str(real)]})
        cleared = client.put("/settings", json={"image_import_roots": []})

    assert bad.status_code == 400
    assert good.status_code == 200
    assert good.json()["image_import_roots"] == [str(real)]
    assert cleared.json()["image_import_roots"] == []


# --------------------------------------------------------------------
# F-list's limits
# --------------------------------------------------------------------


async def test_files_over_f_lists_limits_come_with_a_warning(workbench, outputs) -> None:  # noqa: F811
    big = outputs / "big.png"
    big.write_bytes(gradient_png((900, 900)))
    assert big.stat().st_size > 2_000_000
    wide = outputs / "wide.png"
    wide.write_bytes(png_bytes((4000, 4)))

    async with mcp_client("character") as session:
        _, body = await call_tool(
            session,
            "import_images",
            character=CHAR,
            items=[{"source_path": str(big)}, {"source_path": str(wide)}],
        )

    big_result, wide_result = body["results"]
    assert big_result["warnings"] == ["over_2mb"]
    assert big_result["extension"] == "png"
    assert wide_result["warnings"] == ["over_4000px"]


async def test_convert_to_jpeg_shrinks_an_oversized_png(workbench, outputs) -> None:  # noqa: F811
    big = outputs / "big.png"
    big.write_bytes(gradient_png((900, 900)))

    async with mcp_client("character") as session:
        _, body = await call_tool(
            session,
            "import_image",
            character=CHAR,
            source_path=str(big),
            convert_to_jpeg=True,
        )

    assert body["converted"] is True
    assert body["extension"] == "jpg"
    assert body["bytes"] < 2_000_000
    assert body["warnings"] == []
    assert (body["width"], body["height"]) == (900, 900)
    stored = workbench.images_dir("42") / f"{body['image_id']}.jpg"
    assert stored.read_bytes()[:3] == b"\xff\xd8\xff"
    assert big.read_bytes()[:4] == b"\x89PNG"  # the source is untouched


async def test_convert_to_jpeg_leaves_transparency_alone(workbench, outputs) -> None:  # noqa: F811
    seethrough = outputs / "cutout.png"
    seethrough.write_bytes(gradient_png((800, 800), alpha=100))

    async with mcp_client("character") as session:
        _, body = await call_tool(
            session,
            "import_image",
            character=CHAR,
            source_path=str(seethrough),
            convert_to_jpeg=True,
        )

    assert body["converted"] is False
    assert body["extension"] == "png"
    assert body["warnings"] == ["over_2mb", "not_converted_transparency"]


async def test_convert_to_jpeg_ignores_files_within_the_limits(workbench, outputs) -> None:  # noqa: F811
    small = outputs / "small.png"
    small.write_bytes(png_bytes((16, 16)))
    async with mcp_client("character") as session:
        _, body = await call_tool(
            session,
            "import_image",
            character=CHAR,
            source_path=str(small),
            convert_to_jpeg=True,
        )
    assert body["converted"] is False
    assert body["extension"] == "png"


# --------------------------------------------------------------------
# Onto the profile
# --------------------------------------------------------------------


async def test_a_batch_replaces_each_image_in_its_own_place(workbench, outputs) -> None:  # noqa: F811
    old_ids = ["101", "102", "103", "104", "105"]
    for n, image_id in enumerate(old_ids):
        put_on_disk(workbench, image_id, jpeg_bytes((10 + n, 10)))
    sources = []
    for n in range(3):
        src = outputs / f"edited_{n}.jpg"
        src.write_bytes(jpeg_bytes((40 + n, 40)))
        sources.append(src)

    async with mcp_client("character") as session:
        await make_draft(session)
        seed_gallery(workbench, old_ids)
        payload = payload_of(workbench)
        payload["images"][1]["description"] = "kept caption"
        bench = workbench.resolve_workbench("42", create=False)
        workbench.write_set_payload("42", bench.id, payload, expected_etag=None)

        _, body = await call_tool(
            session,
            "import_images",
            character=CHAR,
            items=[
                {"source_path": str(sources[0]), "replace_image_id": "102"},
                {"source_path": str(sources[1]), "replace_image_id": "104"},
                {
                    "source_path": str(sources[2]),
                    "replace_image_id": "101",
                    "description": "new caption",
                },
            ],
        )
        _, listing = await call_tool(session, "list_images", character=CHAR)

    new_ids = [r["image_id"] for r in body["results"]]
    assert [r["replaced"] for r in body["results"]] == ["102", "104", "101"]
    assert [r["sort_order"] for r in body["results"]] == [1, 3, 0]

    rows = payload_of(workbench)["images"]
    assert [r["image_id"] for r in rows] == [new_ids[2], new_ids[0], "103", new_ids[1], "105"]
    assert [r["sort_order"] for r in rows] == [0, 1, 2, 3, 4]
    assert rows[1]["description"] == "kept caption"
    assert rows[0]["description"] == "new caption"

    in_pool = {r["image_id"] for r in listing["not_on_profile"]}
    assert {"101", "102", "104"} <= in_pool
    assert {"101.jpg", "102.jpg", "104.jpg"} <= pool_files(workbench)


async def test_add_to_gallery_appends_in_the_order_given(workbench, outputs) -> None:  # noqa: F811
    srcs = []
    for n in range(2):
        src = outputs / f"n{n}.png"
        src.write_bytes(png_bytes((8 + n, 8)))
        srcs.append(src)

    async with mcp_client("character") as session:
        await make_draft(session)
        seed_gallery(workbench, [])
        _, body = await call_tool(
            session,
            "import_images",
            character=CHAR,
            add_to_gallery=True,
            items=[{"source_path": str(s), "description": f"d{i}"} for i, s in enumerate(srcs)],
        )

    rows = payload_of(workbench)["images"]
    assert [r["image_id"] for r in rows] == [r["image_id"] for r in body["results"]]
    assert [r["description"] for r in rows] == ["d0", "d1"]
    assert all(r["on_profile"] for r in body["results"])


async def test_one_bad_item_means_nothing_is_imported(workbench, outputs) -> None:  # noqa: F811
    good = outputs / "good.png"
    good.write_bytes(png_bytes((8, 8)))

    async with mcp_client("character") as session:
        await make_draft(session)
        seed_gallery(workbench, [])
        missing_target, _ = await call_tool(
            session,
            "import_images",
            character=CHAR,
            items=[
                {"source_path": str(good)},
                {"source_path": str(good), "replace_image_id": "999"},
            ],
        )
        missing_file, _ = await call_tool(
            session,
            "import_images",
            character=CHAR,
            items=[
                {"source_path": str(good)},
                {"source_path": str(outputs / "gone.png")},
            ],
        )

    assert "Nothing was imported" in tool_error_text(missing_target)
    assert "Item 1" in tool_error_text(missing_file)
    assert "source_not_found" in tool_error_text(missing_file)
    assert pool_files(workbench) == set()
    assert payload_of(workbench)["images"] == []


# --------------------------------------------------------------------
# list_images
# --------------------------------------------------------------------


async def test_the_pool_listing_says_what_a_file_is_and_who_uses_it(
    workbench, outputs  # noqa: F811
) -> None:
    src = outputs / "Profil_final_07.png"
    src.write_bytes(png_bytes((30, 50)))
    put_on_disk(workbench, "555", jpeg_bytes((12, 12)))
    live = workbench.read_live("42")
    live["images"] = [{"image_id": "555", "extension": "jpg", "description": "", "sort_order": 0}]
    workbench.write_live("42", live)
    workbench.save_snapshot("42")

    async with mcp_client("character") as session:
        await make_draft(session)
        seed_gallery(workbench, [])
        _, imported = await call_tool(
            session, "import_image", character=CHAR, source_path=str(src)
        )
        _, listing = await call_tool(session, "list_images", character=CHAR)

    pool = {r["image_id"]: r for r in listing["not_on_profile"]}
    mine = pool[imported["image_id"]]
    assert (mine["width"], mine["height"]) == (30, 50)
    assert mine["source_name"] == "Profil_final_07.png"
    assert mine["sha256"] == imported["sha256"]
    assert mine["referenced_by"] == {"working_sets": [], "live": False, "snapshots": 0}

    pulled = pool["555"]
    assert pulled["source_name"] is None
    assert pulled["referenced_by"]["live"] is True
    assert pulled["referenced_by"]["snapshots"] == 1
