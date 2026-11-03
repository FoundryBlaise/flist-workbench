"""Two writers on one character at once, from outside the sidecar.

The window saves the Workbench over REST; a model edits it over MCP.
Both can be at work on the same character at the same moment, each on
its own thread. Every write is checked against the etag its writer
read, under one lock per character, so of two writes that read the same
Workbench exactly one lands and the other is refused; neither is ever
lost without its writer being told.

These tests run the writers side by side and judge only what is on
disk afterwards and what each writer was told, never the order things
happened in. `sys.setswitchinterval` makes the threads take turns often,
so the writes really do interleave.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import importlib
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

import archive_images
import archive_live
import archive_workbench

from mcp_helpers import call_tool, mcp_client
from sidecar_client import app_client
from test_mcp_reads import MAPPING

NAME = "Lady Amber Blaise"
URL = "/flist/character/42/workbench/payload"
ROUNDS = 40


@pytest.fixture
def sidecar(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")

    import archive_live
    import archive_registry
    import paths

    importlib.reload(paths)
    importlib.reload(archive_registry)

    cache = archive_registry.cache_root() / "mapping-list.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(MAPPING), encoding="utf-8")

    archive_registry.register_character("42", NAME)
    archive_live.write_live(
        "42",
        {
            "character": {"id": 42, "name": NAME, "description": "start"},
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1700000000,
        },
    )

    import server
    from services import mapping as mapping_service

    mapping_service.invalidate()
    importlib.reload(server)
    yield server
    mapping_service.invalidate()


@contextmanager
def threads_taking_turns_often():
    previous = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        yield
    finally:
        sys.setswitchinterval(previous)


def _tokens(description: str) -> list[str]:
    return [line for line in description.split("\n") if line and line != "start"]


def test_a_window_save_and_a_model_edit_never_overwrite_each_other_silently(
    sidecar,
) -> None:
    """Both append their own line to the description. Every line a
    writer was told it saved is there once at the end, and no line whose
    save was refused is."""
    # Outside a `with` block every request runs on its own event loop
    # thread, as threadpool work would.
    api = app_client(sidecar.app)
    assert api.get(URL).status_code == 200  # makes the Workbench from Live

    window_saved: list[str] = []
    window_refused: list[str] = []
    model_saved: list[str] = []
    model_refused: list[str] = []
    #: (etag, description) for every read and save either writer saw.
    seen: list[tuple[str, str]] = []

    def window() -> None:
        for i in range(ROUNDS):
            got = api.get(URL)
            assert got.status_code == 200, got.text
            read = got.json()
            payload = read["payload"]
            seen.append((read["etag"], payload["character"]["description"]))
            line = f"window {i}"
            payload["character"]["description"] += f"\n{line}"
            if "character.description" not in payload["_overlay"]:
                payload["_overlay"].append("character.description")
            res = api.put(URL, json=payload, headers={"If-Match": read["etag"]})
            if res.status_code == 200:
                window_saved.append(line)
                seen.append((res.json()["etag"], payload["character"]["description"]))
            else:
                assert res.status_code == 409, res.text
                assert res.json()["code"] == "etag_mismatch"
                window_refused.append(line)

    def model() -> None:
        async def run() -> None:
            # The full endpoint: it alone carries the raw payload read.
            async with mcp_client() as session:
                for j in range(ROUNDS):
                    line = f"model {j}"
                    result, _ = await call_tool(
                        session, "append_description", character=NAME, text=line
                    )
                    (model_refused if result.isError else model_saved).append(line)
                    _, raw = await call_tool(
                        session, "get_workbench_payload", character=NAME
                    )
                    seen.append(
                        (raw["etag"], raw["payload"]["character"]["description"])
                    )

        asyncio.run(run())

    with threads_taking_turns_often(), ThreadPoolExecutor(2) as pool:
        for future in [pool.submit(window), pool.submit(model)]:
            future.result()

    final = api.get(URL).json()["payload"]["character"]["description"]
    lines = _tokens(final)
    assert sorted(lines) == sorted(window_saved + model_saved)
    assert len(lines) == len(set(lines))
    assert not set(lines) & set(window_refused + model_refused)

    # A payload and its etag come from one read: an etag always names
    # the same contents, whoever read it.
    by_etag: dict[str, set[str]] = {}
    for etag, description in seen:
        by_etag.setdefault(etag, set()).add(description)
    assert {e: d for e, d in by_etag.items() if len(d) > 1} == {}


def test_making_the_workbench_from_live_never_overwrites_a_save(sidecar) -> None:
    """The first look at a character makes its Workbench from Live. A
    second look arriving at the same moment must not make it again over
    a save that landed in between."""
    import archive_live
    import archive_registry

    ids = [str(100 + n) for n in range(12)]
    for cid in ids:
        archive_registry.register_character(cid, f"Char {cid}")
        archive_live.write_live(
            cid,
            {
                "character": {"id": int(cid), "name": f"Char {cid}", "description": "live"},
                "images": [],
                "fetched_at": 1700000000,
            },
        )
    api = app_client(sidecar.app)
    saved: dict[str, str] = {}

    def window(cid: str) -> None:
        url = f"/flist/character/{cid}/workbench/payload"
        read = api.get(url).json()
        payload = read["payload"]
        payload["character"]["description"] = f"edited {cid}"
        payload["_overlay"] = ["character.description"]
        res = api.put(url, json=payload, headers={"If-Match": read["etag"]})
        if res.status_code == 200:
            saved[cid] = payload["character"]["description"]
        else:
            assert res.json()["code"] == "etag_mismatch", res.text

    def first_look(cid: str) -> None:
        assert api.get(f"/flist/character/{cid}/workbench").status_code == 200

    with threads_taking_turns_often(), ThreadPoolExecutor(8) as pool:
        futures = []
        for cid in ids:
            futures += [pool.submit(first_look, cid), pool.submit(window, cid)]
            futures += [pool.submit(first_look, cid) for _ in range(2)]
        for future in futures:
            future.result()

    assert saved, "no save went through"
    for cid, description in saved.items():
        payload = api.get(f"/flist/character/{cid}/workbench/payload").json()["payload"]
        assert payload["character"]["description"] == description, cid


# ---- the archive's own writers ----------------------------------------
#
# Gallery repair and image-id adoption rewrite the Workbench too, under
# the etag they read. Under the lock nothing else can save in between;
# these tests make a save land there anyway, standing in for a writer
# that would skip the lock, and check the conflict is reported and the
# files left as the gallery names them.


@pytest.fixture
def a_save_lands_after_the_next_read(monkeypatch: pytest.MonkeyPatch):
    original = archive_workbench.read_workbench

    def read_then_save(character_id, **kwargs):  # noqa: ANN001, ANN202
        monkeypatch.setattr(archive_workbench, "read_workbench", original)
        read = original(character_id, **kwargs)
        if read is not None:
            payload = copy.deepcopy(read.payload)
            payload["character"]["description"] = "saved meanwhile"
            archive_workbench.write_workbench(
                character_id, payload, expected_etag=read.etag
            )
        return read

    def arm() -> None:
        monkeypatch.setattr(archive_workbench, "read_workbench", read_then_save)

    return arm


def _png(seed: bytes) -> bytes:
    return b"\x89PNG\r\n\x1a\n" + seed * 16


def _set_gallery(*image_ids: str) -> None:
    bench = archive_workbench.read_workbench("42", create=True)
    payload = {
        **bench.payload,
        "_overlay": ["images"],
        "images": [
            {"image_id": i, "description": "", "sort_order": n}
            for n, i in enumerate(image_ids)
        ],
    }
    archive_workbench.write_workbench("42", payload, expected_etag=bench.etag)


def _gallery_and_files_agree() -> list[str]:
    """Gallery ids with no file behind them."""
    bench = archive_workbench.read_workbench("42")
    on_disk = {p.stem for p in archive_images.images_dir("42").iterdir() if p.is_file()}
    return [r["image_id"] for r in bench.payload["images"] if r["image_id"] not in on_disk]


def test_a_repair_refused_by_a_save_reports_the_conflict_and_moves_no_file(
    sidecar, a_save_lands_after_the_next_read
) -> None:
    """F-list gave a re-uploaded picture a new id; repair moves the
    slot to it and sends the old file to the Trash. When the Workbench
    write is refused, the slot still names the old file, so the file
    must stay."""
    api = app_client(sidecar.app)
    picture = _png(b"b")
    live = archive_live.read_live("42")
    archive_live.write_live("42", {**live, "images": [{"image_id": "777", "extension": "png"}]})
    archive_images.write_character_image("42", "777", "png", picture)
    archive_images.write_character_image("42", "666", "png", picture)
    _set_gallery("666")

    a_save_lands_after_the_next_read()
    res = api.post("/flist/character/42/images/repair")

    assert res.status_code == 409, res.text
    assert res.json()["code"] == "etag_mismatch"
    bench = archive_workbench.read_workbench("42")
    assert bench.payload["character"]["description"] == "saved meanwhile"
    assert [r["image_id"] for r in bench.payload["images"]] == ["666"]
    assert _gallery_and_files_agree() == []


def test_an_adoption_refused_by_a_save_reports_the_conflict_and_moves_no_file(
    sidecar, a_save_lands_after_the_next_read
) -> None:
    """Our upload turned out to be on F-list under a real id: listing
    the images hands the slot over and drops the twin. When the
    Workbench write is refused, the slot still names our upload, so its
    file must stay."""
    api = app_client(sidecar.app)
    picture = _png(b"a")
    local_id = f"local-{hashlib.sha256(picture).hexdigest()[:8]}"
    archive_images.add_uploaded_image("42", picture)
    archive_images.write_character_image("42", "47000849", "png", picture)
    _set_gallery(local_id)

    a_save_lands_after_the_next_read()
    res = api.get("/flist/character/42/images")

    assert res.status_code == 409, res.text
    assert res.json()["code"] == "etag_mismatch"
    bench = archive_workbench.read_workbench("42")
    assert bench.payload["character"]["description"] == "saved meanwhile"
    assert [r["image_id"] for r in bench.payload["images"]] == [local_id]
    assert _gallery_and_files_agree() == []


def test_a_refused_adoption_puts_a_renamed_file_back(
    sidecar, a_save_lands_after_the_next_read
) -> None:
    """The extension names the id F-list gave our upload, and no file
    holds that id yet: the upload's file is renamed to it. When the
    Workbench write is refused, the rename is undone."""
    from archive_errors import WorkbenchConflict

    picture = _png(b"c")
    local_id = archive_images.add_uploaded_image("42", picture)["image_id"]
    _set_gallery(local_id)

    a_save_lands_after_the_next_read()
    with pytest.raises(WorkbenchConflict):
        archive_images.adopt_flist_image_ids("42", {local_id: "47000850"})

    on_disk = sorted(p.name for p in archive_images.images_dir("42").iterdir())
    assert on_disk == [f"{local_id}.png"]
    assert _gallery_and_files_agree() == []


# ---- Backups ------------------------------------------------------------


def test_naming_several_backups_at_once_keeps_every_name(sidecar) -> None:
    """The names live in one file beside the Backups; each rename reads
    it, changes one entry and writes it back."""
    api = app_client(sidecar.app)
    filenames = [
        api.post("/flist/character/42/zip-backup").json()["filename"] for _ in range(8)
    ]

    def rename(filename: str) -> None:
        res = api.patch(
            f"/flist/character/42/zip-backups/{filename}", json={"name": f"named {filename}"}
        )
        assert res.status_code == 200, res.text

    with threads_taking_turns_often(), ThreadPoolExecutor(8) as pool:
        for future in [pool.submit(rename, f) for f in filenames]:
            future.result()

    rows = api.get("/flist/character/42/zip-backups").json()["backups"]
    assert {r["filename"]: r["name"] for r in rows} == {
        f: f"named {f}" for f in filenames
    }
