"""Each character is moved once to one Workbench on disk (ADR 0001).

Older versions kept several drafts per character under `sets/<id>/`
with an `active_set.json` pointer, a JSON copy of Live per Pull under
`snapshots/` (and before that loose in `backups/`), and before all of
that a single `working.json`. At startup each character is moved to the
one shape the window shows: Live, one `workbench/` folder, Backups. The
Workbench is the draft the window showed (the active one, else the most
recently changed); every old file goes into one Backup, verbatim.

Driven from outside: an archive in an old shape on disk, the sidecar
started over it, and what the routes answer and the disk holds after.
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest
from sidecar_client import app_client

CID = "42"
NAME = "Mirela Thornquist"


def _live() -> dict:
    return {
        "name": NAME,
        "character": {"id": int(CID), "name": NAME, "description": "[b]As published.[/b]"},
        "infotags": {"2": "Human"},
        "kinks": {"580": "fave"},
        "custom_kinks": {},
        "inlines": {},
        "images": [],
        "fetched_at": 1000,
    }


def _draft(description: str) -> dict:
    return {
        "_schema_version": 6,
        "_overlay": ["character.description"],
        "character": {"id": int(CID), "name": NAME, "description": description},
        "infotags": {"2": "Human"},
        "kinks": {"580": "fave"},
        "custom_kinks": {},
        "images": [],
    }


class OldArchive:
    """One character's folder, written the way older versions left it."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder

    def write(self, rel: str, data: bytes | dict) -> bytes:
        path = self.folder / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = data if isinstance(data, bytes) else json.dumps(data, indent=2).encode()
        path.write_bytes(raw)
        return raw

    def draft(self, set_id: str, name: str, description: str, *, updated_at: int) -> bytes:
        """A draft as `sets/<id>/`; returns its payload bytes."""
        self.write(
            f"sets/{set_id}/meta.json",
            {"id": set_id, "name": name, "created_at": 100, "updated_at": updated_at},
        )
        return self.write(f"sets/{set_id}/payload.json", _draft(description))

    def point_at(self, set_id: str) -> None:
        self.write("active_set.json", {"active_set_id": set_id})

    def files(self) -> dict[str, bytes]:
        """Every file in the folder, by path below it."""
        return {
            p.relative_to(self.folder).as_posix(): p.read_bytes()
            for p in sorted(self.folder.rglob("*"))
            if p.is_file()
        }


@pytest.fixture
def old(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> OldArchive:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import character_archive
    import paths
    import restore

    importlib.reload(paths)
    importlib.reload(character_archive)
    importlib.reload(restore)
    character_archive.register_character(CID, NAME)
    character_archive.write_live(CID, _live())
    return OldArchive(character_archive.character_dir(CID))


def start(old: OldArchive) -> dict:
    """Start the sidecar over the archive and read what the window would."""
    import importlib

    import server

    # A fresh app per start: the MCP session managers run once each.
    importlib.reload(server)
    with app_client(server.app) as window:
        bench = window.get(f"/flist/character/{CID}/workbench/payload?create=false")
        backups = window.get(f"/flist/character/{CID}/zip-backups").json()["backups"]
    return {
        "workbench": bench.json()["payload"] if bench.status_code == 200 else None,
        "backups": backups,
    }


def migration_backup(old: OldArchive, seen: dict) -> dict[str, bytes]:
    """The members of the one migration Backup, by name."""
    [entry] = [b for b in seen["backups"] if b["occasion"] == "migration"]
    assert entry["source"] == "workbench"
    with zipfile.ZipFile(old.folder / "backups" / entry["filename"]) as zf:
        return {name: zf.read(name) for name in zf.namelist()}


def old_layout(files: dict[str, bytes]) -> list[str]:
    """The files of the old layouts among `files`."""
    return [
        rel for rel in files
        if rel.startswith(("sets/", "snapshots/", "active_set.json", "working."))
        or (rel.startswith("backups/") and rel.endswith(".json"))
    ]


def assert_kept_verbatim(before: dict[str, bytes], members: dict[str, bytes], *rels: str) -> None:
    held = {hashlib.sha256(b).hexdigest() for b in members.values()}
    for rel in rels:
        assert hashlib.sha256(before[rel]).hexdigest() in held, f"{rel} is not in the Backup"


def assert_one_workbench_shape(old: OldArchive) -> None:
    names = {p.name for p in old.folder.iterdir()}
    assert "sets" not in names
    assert "active_set.json" not in names
    assert "snapshots" not in names
    assert not {n for n in names if n.startswith("working.")}, names


def test_a_single_draft_becomes_the_workbench(old: OldArchive) -> None:
    old.draft("aaaaaaaaaaaa", "Workbench", "[b]My draft.[/b]", updated_at=500)
    old.point_at("aaaaaaaaaaaa")
    before = old.files()

    seen = start(old)

    assert seen["workbench"] == _draft("[b]My draft.[/b]")
    assert_kept_verbatim(
        before,
        migration_backup(old, seen),
        "sets/aaaaaaaaaaaa/payload.json",
        "sets/aaaaaaaaaaaa/meta.json",
        "active_set.json",
    )
    assert_one_workbench_shape(old)

    after_first = old.files()
    again = start(old)
    assert old.files() == after_first
    assert again == seen


def assert_second_start_changes_nothing(old: OldArchive, seen: dict) -> None:
    after_first = old.files()
    again = start(old)
    assert old.files() == after_first
    assert again == seen


def test_of_several_drafts_the_active_one_becomes_the_workbench(old: OldArchive) -> None:
    old.draft("aaaaaaaaaaaa", "Main", "[b]The one I was editing.[/b]", updated_at=500)
    old.draft("bbbbbbbbbbbb", "Modern AU", "[b]Newer, never shown.[/b]", updated_at=900)
    old.point_at("aaaaaaaaaaaa")
    before = old.files()

    seen = start(old)

    assert seen["workbench"] == _draft("[b]The one I was editing.[/b]")
    assert_kept_verbatim(before, migration_backup(old, seen), *old_layout(before))
    assert_one_workbench_shape(old)
    assert_second_start_changes_nothing(old, seen)


def test_without_a_pointer_the_most_recently_changed_draft_becomes_the_workbench(
    old: OldArchive,
) -> None:
    old.draft("aaaaaaaaaaaa", "Older", "[b]Older.[/b]", updated_at=500)
    old.draft("bbbbbbbbbbbb", "Newer", "[b]Newer.[/b]", updated_at=900)
    old.draft("cccccccccccc", "Oldest", "[b]Oldest.[/b]", updated_at=100)
    before = old.files()

    seen = start(old)

    assert seen["workbench"] == _draft("[b]Newer.[/b]")
    assert_kept_verbatim(before, migration_backup(old, seen), *old_layout(before))
    assert_one_workbench_shape(old)
    assert_second_start_changes_nothing(old, seen)


def test_old_copies_of_live_go_into_the_backup_with_the_drafts(old: OldArchive) -> None:
    old.draft("aaaaaaaaaaaa", "Workbench", "[b]My draft.[/b]", updated_at=500)
    old.draft("bbbbbbbbbbbb", "Spare", "[b]Spare.[/b]", updated_at=400)
    old.point_at("aaaaaaaaaaaa")
    old.write("snapshots/1700000000.json", {**_live(), "fetched_at": 1700000000})
    old.write("snapshots/1700000500-1.json", {**_live(), "fetched_at": 1700000500})
    # Before `snapshots/` existed, the copies lay loose in `backups/`.
    old.write("backups/1600000000.json", {**_live(), "fetched_at": 1600000000})
    before = old.files()

    seen = start(old)

    assert seen["workbench"] == _draft("[b]My draft.[/b]")
    assert_kept_verbatim(before, migration_backup(old, seen), *old_layout(before))
    assert_one_workbench_shape(old)
    assert not (old.folder / "backups" / "1600000000.json").exists()
    assert_second_start_changes_nothing(old, seen)


def test_a_character_with_only_live_gets_its_workbench_from_live(old: OldArchive) -> None:
    import character_archive

    before = old.files()

    seen = start(old)

    # Nothing was edited yet, so nothing is kept and no Workbench made:
    # the first edit makes it from Live, as it did before.
    assert seen == {"workbench": None, "backups": []}
    assert set(old.files()) - set(before) == {"layout.json"}
    assert_second_start_changes_nothing(old, seen)

    import server

    made = app_client(server.app).get(f"/flist/character/{CID}/workbench/payload").json()
    assert made["created"] is True
    assert made["payload"] == character_archive._seed_payload_from_live(_live())


def test_a_leftover_working_copy_goes_into_the_backup(old: OldArchive) -> None:
    """The single working copy from before drafts existed. The window
    never showed it beside a draft, so the Workbench stays what it was;
    the file is kept in the Backup."""
    old.draft("aaaaaaaaaaaa", "Workbench", "[b]My draft.[/b]", updated_at=500)
    old.point_at("aaaaaaaaaaaa")
    old.write("working.json", {**_draft("[b]From long ago.[/b]"), "_schema_version": 5})
    old.write("working.bak", b"{\"half\": ")
    before = old.files()

    seen = start(old)

    assert seen["workbench"] == _draft("[b]My draft.[/b]")
    assert_kept_verbatim(before, migration_backup(old, seen), "working.json", "working.bak")
    assert_one_workbench_shape(old)
    assert_second_start_changes_nothing(old, seen)


def test_a_leftover_working_copy_alone_is_kept_and_live_seeds_the_workbench(
    old: OldArchive,
) -> None:
    old.write("working.json", {**_draft("[b]From long ago.[/b]"), "_schema_version": 5})
    before = old.files()

    seen = start(old)

    assert seen["workbench"] is None
    assert_kept_verbatim(before, migration_backup(old, seen), "working.json")
    assert_one_workbench_shape(old)
    assert_second_start_changes_nothing(old, seen)


def test_a_half_migrated_character_is_finished(old: OldArchive) -> None:
    """An earlier start wrote the Workbench and the Backup and had
    removed some old files when it stopped."""
    payload = old.draft("aaaaaaaaaaaa", "Main", "[b]Mine.[/b]", updated_at=500)
    old.draft("bbbbbbbbbbbb", "Spare", "[b]Spare.[/b]", updated_at=900)
    old.point_at("aaaaaaaaaaaa")
    old.write("snapshots/1700000000.json", _live())
    old.write("workbench/payload.json", payload)
    old.write("workbench/meta.json", {"created_at": 100, "updated_at": 500})
    everything = old.files()
    packed = io.BytesIO()
    with zipfile.ZipFile(packed, "w") as zf:
        for rel, data in everything.items():
            if not rel.startswith(("workbench/", "live.json")):
                zf.writestr(rel, data)
        zf.writestr(
            "backup-meta.json",
            json.dumps({"source": "workbench", "occasion": "migration", "created_at": 1}),
        )
    old.write("backups/2026-01-01T000000Z.zip", packed.getvalue())
    for rel in ("sets/bbbbbbbbbbbb/payload.json", "sets/bbbbbbbbbbbb/meta.json",
                "snapshots/1700000000.json"):
        (old.folder / rel).unlink()
    before = old.files()

    seen = start(old)

    assert seen["workbench"] == _draft("[b]Mine.[/b]")
    assert_kept_verbatim(before, migration_backup(old, seen), *old_layout(before))
    assert_one_workbench_shape(old)
    assert_second_start_changes_nothing(old, seen)


def test_a_backup_that_cannot_be_written_leaves_everything_and_is_retried(
    old: OldArchive, monkeypatch: pytest.MonkeyPatch
) -> None:
    import server

    old.draft("aaaaaaaaaaaa", "Main", "[b]Mine.[/b]", updated_at=500)
    old.draft("bbbbbbbbbbbb", "Spare", "[b]Spare.[/b]", updated_at=900)
    old.point_at("aaaaaaaaaaaa")
    before = old.files()

    def disk_full(*_args, **_kwargs):
        raise OSError("No space left on device")

    with monkeypatch.context() as m:
        m.setattr(zipfile.ZipFile, "writestr", disk_full)
        seen = start(old)

    # Readable as before, every old file still in place.
    assert seen == {"workbench": _draft("[b]Mine.[/b]"), "backups": []}
    assert all(old.files().get(rel) == data for rel, data in before.items())
    # The window saves an edit before the next start.
    window = app_client(server.app)
    url = f"/flist/character/{CID}/workbench/payload"
    current = window.get(url).json()
    edited = {**current["payload"], "character": {
        **current["payload"]["character"], "description": "[b]Mine, edited.[/b]"}}
    assert window.put(url, json=edited, headers={"If-Match": current["etag"]}).status_code == 200

    seen = start(old)

    assert seen["workbench"]["character"]["description"] == "[b]Mine, edited.[/b]"
    assert_kept_verbatim(before, migration_backup(old, seen), *old_layout(before))
    assert_one_workbench_shape(old)
    assert_second_start_changes_nothing(old, seen)


def test_a_migration_stopped_while_removing_old_files_completes_next_start(
    old: OldArchive, monkeypatch: pytest.MonkeyPatch
) -> None:
    import os

    old.draft("aaaaaaaaaaaa", "Main", "[b]Mine.[/b]", updated_at=500)
    old.draft("bbbbbbbbbbbb", "Spare", "[b]Spare.[/b]", updated_at=900)
    old.draft("cccccccccccc", "Other", "[b]Other.[/b]", updated_at=700)
    old.write("snapshots/1700000000.json", _live())
    old.point_at("aaaaaaaaaaaa")
    before = old.files()
    real_unlink = os.unlink
    calls = []

    def crash_on_third(path, *args, **kwargs):
        calls.append(path)
        if len(calls) == 3:
            raise OSError("the machine went to sleep")
        return real_unlink(path, *args, **kwargs)

    with monkeypatch.context() as m:
        m.setattr(os, "unlink", crash_on_third)
        stopped = start(old)

    assert stopped["workbench"] == _draft("[b]Mine.[/b]")
    assert (old.folder / "sets").exists(), "the stop left old files behind"
    assert_kept_verbatim(before, migration_backup(old, stopped), *old_layout(before))

    seen = start(old)

    assert seen == stopped, "finishing needs no second Backup"
    assert_one_workbench_shape(old)
    assert_second_start_changes_nothing(old, seen)


def test_the_migration_backup_is_listed_to_the_extension_but_not_uploadable(
    old: OldArchive,
) -> None:
    """It holds old files, not a profile: uploading it would write
    nothing sensible into F-list's form."""
    import restore

    old.draft("aaaaaaaaaaaa", "Main", "[b]Mine.[/b]", updated_at=500)
    old.draft("bbbbbbbbbbbb", "Spare", "[b]Spare.[/b]", updated_at=900)
    seen = start(old)
    [backup] = seen["backups"]

    import server

    hs = restore.begin_handshake()
    restore.accept_handshake(hs["handshake_id"])
    try:
        extension = app_client(
            server.app,
            headers={"X-Workbench-Auth": hs["token"], "X-Workbench-Extension-Version": "0.1.1"},
        )
        sources = extension.get("/restore/snapshots", params={"character": NAME}).json()
        fetched = extension.get(
            f"/restore/snapshot/{backup['filename']}", params={"character": NAME}
        )
    finally:
        restore.revoke_token()

    assert [s["id"] for s in sources if s["kind"] == "set"] == ["workbench"]
    [listed] = [s for s in sources if s["id"] == backup["filename"]]
    assert listed["upload_refused"]
    assert fetched.status_code == 409


def test_restoring_the_migration_backup_is_refused_and_keeps_the_workbench(
    old: OldArchive,
) -> None:
    import server

    old.draft("aaaaaaaaaaaa", "Main", "[b]Mine.[/b]", updated_at=500)
    old.draft("bbbbbbbbbbbb", "Spare", "[b]Spare.[/b]", updated_at=900)
    seen = start(old)
    [backup] = seen["backups"]

    window = app_client(server.app)
    res = window.post(
        f"/flist/character/{CID}/workbench/load-backup", json={"filename": backup["filename"]}
    )

    assert res.status_code == 409
    after = window.get(f"/flist/character/{CID}/workbench/payload").json()["payload"]
    assert after == seen["workbench"]


def _with_a_leftover_working_copy(old: OldArchive) -> dict:
    """Started over a draft and a leftover `working.json`: the migration
    Backup then holds a file named like a Backup's own profile, which
    must not make it loadable."""
    old.draft("aaaaaaaaaaaa", "Main", "[b]Mine.[/b]", updated_at=500)
    old.write("working.json", {**_draft("[b]From long ago.[/b]"), "_schema_version": 5})
    return start(old)


def _restore_in_the_window(backup: str) -> tuple[int, str]:
    import server

    res = app_client(server.app).post(
        f"/flist/character/{CID}/workbench/load-backup", json={"filename": backup}
    )
    return res.status_code, res.json().get("code", "")


async def _load_over_mcp(backup: str) -> tuple[int, str]:
    from mcp_helpers import call_tool, mcp_client, tool_error_text

    async with mcp_client("character") as session:
        result, _ = await call_tool(
            session, "load_backup_into_workbench", character=NAME, backup=backup, confirm=True
        )
    return 409, tool_error_text(result)


@pytest.mark.parametrize("load", ["window", "mcp"])
async def test_the_migration_backup_is_never_restored_even_holding_a_working_copy(
    old: OldArchive, load: str
) -> None:
    import server

    seen = _with_a_leftover_working_copy(old)
    [backup] = seen["backups"]

    if load == "window":
        status, said = _restore_in_the_window(backup["filename"])
    else:
        status, said = await _load_over_mcp(backup["filename"])

    assert status == 409
    assert "backup_holds_no_profile" in said
    window = app_client(server.app)
    assert window.get(f"/flist/character/{CID}/workbench/payload").json()["payload"] == (
        seen["workbench"]
    )
    assert window.get(f"/flist/character/{CID}/zip-backups").json()["backups"] == seen["backups"]


def test_the_migration_backup_cannot_be_browsed_as_a_profile(old: OldArchive) -> None:
    import server

    seen = _with_a_leftover_working_copy(old)
    [backup] = seen["backups"]

    res = app_client(server.app).get(
        f"/flist/character/{CID}/zip-backups/{backup['filename']}/payload"
    )

    assert res.status_code == 409
    assert res.json()["code"] == "backup_holds_no_profile"


def test_the_migration_backup_is_never_uploaded_even_holding_a_working_copy(
    old: OldArchive,
) -> None:
    """The extension hears the same refusal as the window and MCP, and
    the source list says the same thing before it asks."""
    import restore
    import server

    seen = _with_a_leftover_working_copy(old)
    [backup] = seen["backups"]

    hs = restore.begin_handshake()
    restore.accept_handshake(hs["handshake_id"])
    try:
        extension = app_client(
            server.app,
            headers={"X-Workbench-Auth": hs["token"], "X-Workbench-Extension-Version": "0.1.1"},
        )
        sources = extension.get("/restore/snapshots", params={"character": NAME}).json()
        fetched = extension.get(
            f"/restore/snapshot/{backup['filename']}", params={"character": NAME}
        )
    finally:
        restore.revoke_token()

    assert fetched.status_code == 409
    assert fetched.json()["code"] == "backup_holds_no_profile"
    [listed] = [s for s in sources if s["id"] == backup["filename"]]
    assert listed["upload_refused"] == fetched.json()["message"]


def test_the_backup_list_says_which_backups_hold_a_profile(old: OldArchive) -> None:
    import server

    _with_a_leftover_working_copy(old)
    window = app_client(server.app)
    assert window.post(f"/flist/character/{CID}/zip-backup").status_code == 200

    backups = window.get(f"/flist/character/{CID}/zip-backups").json()["backups"]

    assert {b["occasion"]: b["holds_profile"] for b in backups} == {
        "migration": False,
        "manual": True,
    }


def test_an_image_named_only_in_the_older_drafts_is_referenced_but_not_kept(
    old: OldArchive,
) -> None:
    """The migration Backup holds JSON only. An image a spare draft named
    is still used somewhere, but no Backup holds its bytes: trashing the
    pool file must not be told it is safely kept."""
    import server

    old.draft("aaaaaaaaaaaa", "Main", "[b]Mine.[/b]", updated_at=900)
    old.write(
        "sets/bbbbbbbbbbbb/payload.json",
        {**_draft("[b]Spare.[/b]"), "images": [{"image_id": "777", "sort_order": 0}]},
    )
    old.write(
        "sets/bbbbbbbbbbbb/meta.json",
        {"id": "bbbbbbbbbbbb", "name": "Spare", "created_at": 100, "updated_at": 500},
    )
    old.point_at("aaaaaaaaaaaa")
    start(old)

    refs = app_client(server.app).get(f"/flist/character/{CID}/image-references").json()

    assert refs["777"] == {
        "workbench": False,
        "live": False,
        "backups": 0,
        "newest_backup": None,
        "migration_backup": True,
    }
