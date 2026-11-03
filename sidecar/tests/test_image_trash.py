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
import archive_backups
import archive_images
import archive_live
import archive_registry
from sidecar_client import app_client
from PIL import Image

from mcp_helpers import call_tool, mcp_client
from test_mcp_edit import open_workbench, payload_of, seed_gallery, workbench  # noqa: F401

CHAR = "Lady Amber Blaise"


def png(n: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (8 + n, 8), (n * 20 % 255, 10, 10)).save(out, "PNG")
    return out.getvalue()


@pytest.fixture
def client(workbench) -> TestClient:  # noqa: F811
    import server

    with app_client(server.app) as c:
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

    restored = client.post("/flist/character/42/trash/put-back", json={"image_ids": ids}).json()
    assert sorted(r["image_id"] for r in restored["restored"]) == sorted(ids)
    assert pool_ids(client) == set(ids)
    assert trash_ids(client) == []


def test_restoring_bytes_the_pool_already_has_makes_no_duplicate(client, workbench) -> None:  # noqa: F811
    iid = upload(client, 3)
    client.delete(f"/flist/character/42/images/{iid}")
    # A pull fetches the same picture again under F-list's id.
    archive_images.write_character_image("42", "47000001", "png", png(3))

    res = client.post("/flist/character/42/trash/put-back", json={"image_ids": [iid]}).json()

    assert res["restored"] == [{"image_id": "47000001", "deduplicated": True, "from": iid}]
    assert pool_ids(client) == {"47000001"}
    assert trash_ids(client) == []


def test_the_window_can_ask_where_an_image_is_used(client, workbench) -> None:  # noqa: F811
    iid = upload(client, 13)
    live = archive_live.read_live("42")
    live["images"] = [{"image_id": iid, "description": "", "sort_order": 0}]
    archive_live.write_live("42", live)

    refs = client.get("/flist/character/42/image-references").json()

    assert refs[iid]["live"] is True
    assert refs[iid]["workbench"] is False


def _set_gallery(client: TestClient, image_ids: list[str]) -> None:
    read = client.get("/flist/character/42/workbench/payload").json()
    payload = read["payload"]
    payload["images"] = [
        {"image_id": i, "description": "", "sort_order": n} for n, i in enumerate(image_ids)
    ]
    res = client.put(
        "/flist/character/42/workbench/payload",
        json=payload,
        headers={"If-Match": read["etag"]},
    )
    assert res.status_code == 200, res.text


def _back_up(client: TestClient) -> str:
    res = client.post("/flist/character/42/zip-backup")
    assert res.status_code == 200 and res.json()["saved"], res.text
    return res.json()["filename"]


def test_image_usage_counts_the_workbench_live_and_backups(client, workbench) -> None:  # noqa: F811
    kept, parked, pulled, older, loose = (upload(client, n) for n in (30, 31, 32, 33, 34))
    live = archive_live.read_live("42")
    live["images"] = [{"image_id": pulled, "description": "", "sort_order": 0}]
    archive_live.write_live("42", live)
    _set_gallery(client, [parked, kept])
    first = _back_up(client)
    _set_gallery(client, [kept])
    second = _back_up(client)
    # A copy of Live an earlier version kept per Pull names `older`;
    # nothing counts it any more.
    old_copies = archive_registry.character_dir("42") / "snapshots"
    old_copies.mkdir()
    (old_copies / "1000.json").write_text(
        '{"images": [{"image_id": "%s"}]}' % older, encoding="utf-8"
    )

    refs = client.get("/flist/character/42/image-references").json()

    assert refs[kept] == {
        "workbench": True, "live": False, "backups": 2, "newest_backup": second,
        "migration_backup": False,
    }
    assert refs[parked] == {
        "workbench": False, "live": False, "backups": 1, "newest_backup": first,
        "migration_backup": False,
    }
    assert refs[pulled] == {
        "workbench": False, "live": True, "backups": 0, "newest_backup": None,
        "migration_backup": False,
    }
    assert older not in refs
    assert loose not in refs


def test_the_window_deletes_a_gallery_image_and_a_pool_image_in_one_request(
    client, workbench  # noqa: F811
) -> None:
    stays, on_profile, loose = (upload(client, n) for n in (14, 15, 16))
    _set_gallery(client, [on_profile, stays])

    res = client.post(
        "/flist/character/42/images/trash", json={"image_ids": [on_profile, loose]}
    )

    assert res.status_code == 200, res.text
    body = res.json()
    assert [t["image_id"] for t in body["trashed"]] == [on_profile, loose]
    assert body["off_gallery"] == [on_profile]
    read = client.get("/flist/character/42/workbench/payload").json()
    # The window saves its next edit over the etag it is given here.
    assert body["etag"] == read["etag"]
    assert [(r["image_id"], r["sort_order"]) for r in read["payload"]["images"]] == [
        (stays, 0)
    ]
    assert pool_ids(client) == {stays}
    assert set(trash_ids(client)) == {on_profile, loose}
    assert {i["deleted_by"] for i in client.get("/flist/character/42/trash").json()["items"]} == {
        "ui"
    }


def test_deleting_only_pool_images_leaves_the_workbench_alone(
    client, workbench  # noqa: F811
) -> None:
    stays, loose = upload(client, 17), upload(client, 18)
    _set_gallery(client, [stays])
    before = client.get("/flist/character/42/workbench/payload").json()["etag"]

    body = client.post(
        "/flist/character/42/images/trash", json={"image_ids": [loose]}
    ).json()

    assert body["off_gallery"] == []
    assert body["etag"] is None
    assert client.get("/flist/character/42/workbench/payload").json()["etag"] == before


def test_unknown_ids_are_reported_not_fatal(client) -> None:
    iid = upload(client, 4)
    res = client.post(
        "/flist/character/42/images/trash", json={"image_ids": [iid, "nope"]}
    ).json()
    assert [t["image_id"] for t in res["trashed"]] == [iid]
    assert res["not_found"] == ["nope"]
    assert client.delete("/flist/character/42/images/nope").status_code == 404


@pytest.mark.invariant_exempt(
    "nothing_vanishes",
    reason="a human emptying the Trash is the one deletion the rule allows",
)
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
    assert {"list_trash", "put_back_images"} <= names
    assert not any(
        ("purge" in n or "empty" in n) and ("trash" in n or "image" in n) for n in names
    ), names


async def test_remove_image_takes_it_off_the_gallery_and_keeps_the_file(
    workbench, client  # noqa: F811
) -> None:
    keep = upload(client, 8)
    drop = upload(client, 9)
    async with mcp_client("character") as session:
        await open_workbench(session)
        seed_gallery(workbench, [keep, drop])
        _, removed = await call_tool(
            session, "remove_image", character=CHAR, image_id=drop
        )

    assert removed["image_id"] == drop
    assert [r["image_id"] for r in payload_of(workbench)["images"]] == [keep]
    assert pool_ids(client) == {keep, drop}
    assert trash_ids(client) == []


async def test_a_model_trashes_gallery_and_pool_images_and_puts_every_one_back(
    workbench, client  # noqa: F811
) -> None:
    on_profile = upload(client, 20)
    loose = upload(client, 21)
    pulled = upload(client, 22)
    stays = upload(client, 23)
    live = archive_live.read_live("42")
    live["images"] = [{"image_id": pulled, "description": "", "sort_order": 0}]
    archive_live.write_live("42", live)

    async with mcp_client("character") as session:
        await open_workbench(session)
        seed_gallery(workbench, [stays, on_profile])
        _, body = await call_tool(
            session,
            "trash_images",
            character=CHAR,
            image_ids=[on_profile, loose, pulled, "ghost"],
        )
        _, listed = await call_tool(session, "list_trash", character=CHAR)
        gallery_after_trash = [r["image_id"] for r in payload_of(workbench)["images"]]
        _, put_back = await call_tool(
            session,
            "put_back_images",
            character=CHAR,
            image_ids=[i["trash_id"] for i in listed["items"]],
        )

    assert body["trashed"] == [on_profile, loose, pulled]
    assert body["off_gallery"] == [on_profile]
    assert body["not_found"] == ["ghost"]
    assert body["on_live_profile"] == [pulled]
    assert gallery_after_trash == [stays]
    assert {i["deleted_by"] for i in listed["items"]} == {"mcp"}
    # Every one comes back, into the pool and not onto the profile.
    assert sorted(r["image_id"] for r in put_back["put_back"]) == sorted(
        [on_profile, loose, pulled]
    )
    assert pool_ids(client) == {on_profile, loose, pulled, stays}
    assert trash_ids(client) == []
    assert [r["image_id"] for r in payload_of(workbench)["images"]] == [stays]


def test_the_trash_remembers_where_an_import_came_from(
    client, workbench, tmp_path: Path  # noqa: F811
) -> None:
    from services import image_import
    from services import settings as settings_service

    folder = tmp_path / "Outputs"
    folder.mkdir()
    settings_service.update({"image_import_roots": [str(folder)]})
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
        await open_workbench(session)
    seed_gallery(workbench, [keep])
    client.delete(f"/flist/character/42/images/{gone}")

    backup = archive_backups.save_zip_backup("42", source="workbench", occasion="manual", force=True)

    names = zipfile.ZipFile(backup["path"]).namelist()
    assert any(keep in n for n in names), names
    assert not any(gone in n for n in names), names
    assert not any("trash" in n for n in names), names


def trash_bytes(client: TestClient) -> dict[str, bytes]:
    """trash_id -> bytes of every file in the Trash."""
    items = client.get("/flist/character/42/trash").json()["items"]
    return {
        i["trash_id"]: client.get(f"/flist/character/42/trash/{i['filename']}").content
        for i in items
    }


def pool_bytes(client: TestClient) -> dict[str, bytes]:
    """image_id -> bytes of every image in the pool."""
    rows = client.get("/flist/character/42/images").json()["images"]
    return {
        r["image_id"]: client.get(
            f"/flist/character/42/images/{r['image_id']}.{r['extension']}"
        ).content
        for r in rows
    }


def test_two_different_files_trashed_under_one_id_are_both_kept(
    client, workbench  # noqa: F811
) -> None:
    # A Pull can put other bytes under an id the pool already had.
    archive_images.write_character_image("42", "47000002", "png", png(30))
    client.delete("/flist/character/42/images/47000002")
    archive_images.write_character_image("42", "47000002", "jpg", png(31))
    client.delete("/flist/character/42/images/47000002")

    items = client.get("/flist/character/42/trash").json()["items"]
    assert [i["image_id"] for i in items] == ["47000002", "47000002"]
    assert sorted(trash_bytes(client).values()) == sorted([png(30), png(31)])

    # Both come back, and neither overwrites the other.
    res = client.post(
        "/flist/character/42/trash/put-back",
        json={"image_ids": [i["trash_id"] for i in items]},
    ).json()
    assert len(res["restored"]) == 2
    assert sorted(pool_bytes(client).values()) == sorted([png(30), png(31)])


def test_trashing_the_same_bytes_twice_keeps_one_copy(client, workbench) -> None:  # noqa: F811
    archive_images.write_character_image("42", "47000003", "png", png(32))
    client.delete("/flist/character/42/images/47000003")
    archive_images.write_character_image("42", "47000003", "png", png(32))
    client.delete("/flist/character/42/images/47000003")

    assert list(trash_bytes(client).values()) == [png(32)]


def test_restoring_onto_a_pool_file_with_other_bytes_keeps_both(
    client, workbench  # noqa: F811
) -> None:
    import hashlib

    archive_images.write_character_image("42", "47000004", "png", png(33))
    client.delete("/flist/character/42/images/47000004")
    # Meanwhile the pool got a different picture under the same name.
    archive_images.write_character_image("42", "47000004", "png", png(34))

    res = client.post(
        "/flist/character/42/trash/put-back", json={"image_ids": ["47000004"]}
    ).json()

    local = f"local-{hashlib.sha256(png(33)).hexdigest()[:8]}"
    assert res["restored"] == [{"image_id": local, "deduplicated": False, "from": "47000004"}]
    assert pool_bytes(client) == {"47000004": png(34), local: png(33)}
    assert trash_bytes(client) == {}


def test_the_trash_lists_the_newest_delete_first(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    from types import SimpleNamespace

    from services import image_trash

    clock = [1_800_000_000]
    monkeypatch.setattr(image_trash, "time", SimpleNamespace(time=lambda: clock[0]))
    ids = [upload(client, n) for n in (40, 41, 42)]
    for iid in (ids[1], ids[0], ids[2]):
        client.delete(f"/flist/character/42/images/{iid}")
        clock[0] += 60

    assert trash_ids(client) == [ids[2], ids[0], ids[1]]
