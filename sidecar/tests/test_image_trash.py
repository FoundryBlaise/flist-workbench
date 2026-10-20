"""The image trash.

A delete used to unlink the file, with a confirm dialog as the only
guard. Now it moves the file to `trash/`, from which it can be restored
until the user empties it in the window. A model can trash and restore,
never delete for good.
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from mcp_helpers import call_tool, mcp_client, tool_error_text
from test_mcp_edit import make_draft, payload_of, seed_gallery, workbench  # noqa: F401

CHAR = "Lady Amber Blaise"


def png(n: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (8 + n, 8), (n * 20 % 255, 10, 10)).save(out, "PNG")
    return out.getvalue()


@pytest.fixture
def client(workbench) -> TestClient:  # noqa: F811
    import server

    with TestClient(server.app) as c:
        yield c


def upload(client: TestClient, n: int) -> str:
    return client.post("/flist/character/42/images", content=png(n)).json()["image_id"]


def pool_ids(client: TestClient) -> set[str]:
    return {r["image_id"] for r in client.get("/flist/character/42/images").json()["images"]}


def trash_ids(client: TestClient) -> list[str]:
    return [r["image_id"] for r in client.get("/flist/character/42/trash").json()["items"]]


def test_deleting_from_the_window_moves_the_file_to_the_trash(client, workbench) -> None:  # noqa: F811
    iid = upload(client, 1)

    res = client.delete(f"/flist/character/42/images/{iid}")

    assert res.status_code == 200
    assert iid not in pool_ids(client)
    items = client.get("/flist/character/42/trash").json()["items"]
    assert [i["image_id"] for i in items] == [iid]
    assert items[0]["deleted_by"] == "ui"
    thumb = client.get(f"/flist/character/42/trash/{items[0]['filename']}")
    assert thumb.status_code == 200
    assert thumb.content == png(1)


def test_ten_images_go_to_the_trash_and_come_back(client) -> None:
    ids = [upload(client, n) for n in range(10)]

    trashed = client.post("/flist/character/42/images/trash", json={"image_ids": ids}).json()
    assert len(trashed["trashed"]) == 10
    assert pool_ids(client) == set()
    assert set(trash_ids(client)) == set(ids)

    restored = client.post("/flist/character/42/trash/restore", json={"image_ids": ids}).json()
    assert sorted(r["image_id"] for r in restored["restored"]) == sorted(ids)
    assert pool_ids(client) == set(ids)
    assert trash_ids(client) == []


def test_restoring_bytes_the_pool_already_has_makes_no_duplicate(client, workbench) -> None:  # noqa: F811
    iid = upload(client, 3)
    client.delete(f"/flist/character/42/images/{iid}")
    # A pull fetches the same picture again under F-list's id.
    workbench.write_character_image("42", "47000001", "png", png(3))

    res = client.post("/flist/character/42/trash/restore", json={"image_ids": [iid]}).json()

    assert res["restored"] == [{"image_id": "47000001", "deduplicated": True, "from": iid}]
    assert pool_ids(client) == {"47000001"}
    assert trash_ids(client) == []


def test_the_window_can_ask_where_an_image_is_used(client, workbench) -> None:  # noqa: F811
    iid = upload(client, 13)
    live = workbench.read_live("42")
    live["images"] = [{"image_id": iid, "description": "", "sort_order": 0}]
    workbench.write_live("42", live)

    refs = client.get("/flist/character/42/image-references").json()

    assert refs[iid]["live"] is True
    assert refs[iid]["working_sets"] == []


def test_unknown_ids_are_reported_not_fatal(client) -> None:
    iid = upload(client, 4)
    res = client.post(
        "/flist/character/42/images/trash", json={"image_ids": [iid, "nope"]}
    ).json()
    assert [t["image_id"] for t in res["trashed"]] == [iid]
    assert res["not_found"] == ["nope"]
    assert client.delete("/flist/character/42/images/nope").status_code == 404


def test_only_the_window_deletes_for_good(client) -> None:
    a, b, c = (upload(client, n) for n in (5, 6, 7))
    client.post("/flist/character/42/images/trash", json={"image_ids": [a, b, c]})

    purged = client.post("/flist/character/42/trash/purge", json={"image_ids": [a]}).json()
    assert purged["purged"] == [a]
    assert set(trash_ids(client)) == {b, c}

    emptied = client.delete("/flist/character/42/trash").json()
    assert emptied["purged"] == 2
    assert trash_ids(client) == []
    assert pool_ids(client) == set()


async def test_mcp_has_no_way_to_delete_for_good(workbench) -> None:  # noqa: F811
    async with mcp_client() as session:
        names = {t.name for t in (await session.list_tools()).tools}
    assert {"list_trash", "restore_image"} <= names
    assert not any(
        ("purge" in n or "empty" in n) and ("trash" in n or "image" in n) for n in names
    ), names


async def test_remove_image_with_delete_file_trashes_and_restore_brings_it_back(
    workbench, client  # noqa: F811
) -> None:
    keep = upload(client, 8)
    drop = upload(client, 9)
    async with mcp_client("character") as session:
        await make_draft(session)
        seed_gallery(workbench, [keep, drop])
        _, removed = await call_tool(
            session,
            "remove_image",
            character=CHAR,
            image_id=drop,
            delete_file=True,
        )
        _, listed = await call_tool(session, "list_trash", character=CHAR)
        _, restored = await call_tool(
            session, "restore_image", character=CHAR, image_id=drop
        )
        missing, _ = await call_tool(
            session, "restore_image", character=CHAR, image_id="not-there"
        )

    assert removed["file_trashed"] is True
    assert [i["image_id"] for i in listed["items"]] == [drop]
    assert listed["items"][0]["deleted_by"] == "mcp"
    assert restored["restored"] == [{"image_id": drop, "deduplicated": False, "from": drop}]
    # Back in the pool, not on the profile.
    assert drop in pool_ids(client)
    assert [r["image_id"] for r in payload_of(workbench)["images"]] == [keep]
    assert "image_not_found" in tool_error_text(missing)


async def test_a_model_can_trash_pool_images_but_not_gallery_ones(
    workbench, client  # noqa: F811
) -> None:
    on_profile = upload(client, 20)
    loose = upload(client, 21)
    pulled = upload(client, 22)
    live = workbench.read_live("42")
    live["images"] = [{"image_id": pulled, "description": "", "sort_order": 0}]
    workbench.write_live("42", live)

    async with mcp_client("character") as session:
        await make_draft(session)
        seed_gallery(workbench, [on_profile])
        refused, _ = await call_tool(
            session, "trash_images", character=CHAR, image_ids=[loose, on_profile]
        )
        _, body = await call_tool(
            session, "trash_images", character=CHAR, image_ids=[loose, pulled, "ghost"]
        )

    text = tool_error_text(refused)
    assert "image_on_profile" in text and on_profile in text
    assert body["trashed"] == [loose, pulled]
    assert body["not_found"] == ["ghost"]
    assert body["on_live_profile"] == [pulled]
    assert set(trash_ids(client)) == {loose, pulled}
    assert pool_ids(client) == {on_profile}
    assert [r["image_id"] for r in payload_of(workbench)["images"]] == [on_profile]


def test_the_trash_remembers_where_an_import_came_from(
    client, workbench, tmp_path: Path  # noqa: F811
) -> None:
    import settings as settings_store
    from services import image_import

    folder = tmp_path / "Outputs"
    folder.mkdir()
    conn = settings_store.connect()
    try:
        image_import.save_import_roots(conn, [str(folder)])
    finally:
        conn.close()
    src = folder / "Profil_final_03.png"
    src.write_bytes(png(10))
    prepared = image_import.prepare(str(src), roots=image_import.import_roots())
    iid = image_import.store("42", prepared)["image_id"]

    client.delete(f"/flist/character/42/images/{iid}")

    item = client.get("/flist/character/42/trash").json()["items"][0]
    assert item["source_name"] == "Profil_final_03.png"


async def test_backups_leave_the_trash_out(client, workbench) -> None:  # noqa: F811
    import zipfile

    keep = upload(client, 11)
    gone = upload(client, 12)
    async with mcp_client("character") as session:
        await make_draft(session)
    seed_gallery(workbench, [keep])
    client.delete(f"/flist/character/42/images/{gone}")

    backup = workbench.save_zip_backup("42", force=True)

    names = zipfile.ZipFile(backup["path"]).namelist()
    assert any(keep in n for n in names), names
    assert not any(gone in n for n in names), names
    assert not any("trash" in n for n in names), names
