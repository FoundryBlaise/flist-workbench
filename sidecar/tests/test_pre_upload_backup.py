"""The Backup taken before every Upload is a Backup like any other.

Before the extension writes a profile into F-list's edit form it sends
the form as it stands, and the app keeps it as a Backup: the way back
if the Upload goes wrong. That Backup has to be where the user looks
for one — the window's Backup list, the MCP Backup list, and the
extension's own list of Upload sources — and it has to restore.

Driven from outside: the extension's routes with the pairing token, the
window's routes, and the MCP tools.
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from sidecar_client import app_client

from mcp_helpers import call_tool, mcp_client

NAME = "Lady Amber Blaise"
PNG = b"\x89PNG\r\n\x1a\n" + b"gallery" * 8
AVATAR = b"\x89PNG\r\n\x1a\n" + b"avatar" * 8

#: What the extension reads off F-list's edit form just before an
#: Upload: form field names, as the page has them.
FORM_STATE = {
    "meta": {"extractedAt": "2026-10-30T12:00:00.000Z", "source": "extension"},
    "character": {
        "id": "42",
        "name": NAME,
        "description": "[b]What F-list had before the Upload.[/b]",
        "customTitle": "Keeper of Lanterns",
    },
    "settings": {"public": True, "customsfirst": True, "showfriends": False},
    "infotags": {"info_2": "Human"},
    "kinks": {"fetish_580": "fave", "fetish_581": "no"},
    "customKinks": [
        {"id": "31712021", "name": "Lantern lore", "description": "Old maps", "choice": "yes"},
    ],
}


@pytest.fixture
def paired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import archive_images
    import archive_live
    import archive_registry
    import paths
    import restore as restore_svc
    import server

    importlib.reload(paths)
    importlib.reload(archive_registry)
    importlib.reload(restore_svc)

    archive_registry.register_character("42", NAME)
    archive_live.write_live(
        "42",
        {
            "name": NAME,
            "character": {"id": 42, "name": NAME, "description": "[b]Published.[/b]"},
            "infotags": {"2": "Human"},
            "kinks": {"580": "fave"},
            "custom_kinks": {},
            "inlines": {},
            "images": [
                {"image_id": "17924625", "extension": "png", "description": "Lantern", "sort_order": 0}
            ],
            "fetched_at": 1000,
        },
    )
    (archive_images.images_dir("42") / "17924625.png").write_bytes(PNG)
    avatar = archive_images.avatar_path_for(NAME)
    avatar.parent.mkdir(parents=True, exist_ok=True)
    avatar.write_bytes(AVATAR)

    hs = restore_svc.begin_handshake()
    restore_svc.accept_handshake(hs["handshake_id"])
    client = app_client(server.app)
    extension = app_client(server.app, headers={"X-Workbench-Auth": hs["token"]})
    yield client, extension
    restore_svc.revoke_token()


def _upload_starts(extension) -> str:
    """The extension's first step of an Upload: back up the form."""
    res = extension.post(
        "/restore/snapshot/fresh", json={"character": NAME, "payload": FORM_STATE}
    )
    assert res.status_code == 200, res.text
    assert res.json()["ok"] is True
    return res.json()["snapshot_id"]


def test_the_window_lists_the_backup_taken_before_an_upload(paired) -> None:
    client, extension = paired
    taken = _upload_starts(extension)

    listed = client.get("/flist/character/42/zip-backups").json()["backups"]

    assert [b["filename"] for b in listed] == [taken]


async def test_mcp_lists_the_backup_taken_before_an_upload(paired) -> None:
    _client, extension = paired
    taken = _upload_starts(extension)

    async with mcp_client("character") as session:
        _result, data = await call_tool(session, "list_backups", character=NAME)

    assert [b["filename"] for b in data["backups"]] == [taken]


def _workbench_payload(client) -> dict:
    return client.get("/flist/character/42/workbench/payload").json()["payload"]


def test_the_backup_taken_before_an_upload_restores_into_the_workbench(paired) -> None:
    client, extension = paired
    taken = _upload_starts(extension)

    res = client.post(
        "/flist/character/42/workbench/load-backup", json={"filename": taken}
    )

    assert res.status_code == 200, res.text
    payload = _workbench_payload(client)
    # What was on F-list's form, in the Workbench's own terms: field ids
    # without the form's `info_` / `fetish_` prefixes, the settings under
    # their Workbench names, custom kinks keyed by id.
    assert payload["character"]["description"] == "[b]What F-list had before the Upload.[/b]"
    assert payload["character"]["custom_title"] == "Keeper of Lanterns"
    assert payload["infotags"] == {"2": "Human"}
    assert payload["kinks"] == {"580": "fave", "581": "no"}
    assert payload["settings"]["customs_first"] is True
    assert payload["settings"]["show_friends"] is False
    assert payload["custom_kinks"]["31712021"]["name"] == "Lantern lore"
    assert payload["custom_kinks"]["31712021"]["choice"] == "yes"
    assert [i["image_id"] for i in payload["images"]] == ["17924625"]


async def test_mcp_restores_the_backup_taken_before_an_upload(paired) -> None:
    client, extension = paired
    taken = _upload_starts(extension)

    async with mcp_client("character") as session:
        result, data = await call_tool(
            session, "load_backup_into_workbench", character=NAME, backup=taken, confirm=True
        )

    assert not result.isError, data
    assert _workbench_payload(client)["kinks"] == {"580": "fave", "581": "no"}


def _zip(data: bytes) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(data))


def test_the_extension_offers_the_backup_as_an_upload_source(paired) -> None:
    _client, extension = paired
    taken = _upload_starts(extension)

    sources = extension.get("/restore/snapshots", params={"character": NAME}).json()

    offered = [s for s in sources if s["id"] == taken]
    assert len(offered) == 1
    # The extension files these under its own "Pre-restore" heading.
    assert offered[0]["kind"] == "pre-restore"
    res = extension.get(f"/restore/snapshot/{taken}", params={"character": NAME})
    assert res.status_code == 200
    # character.json is what the extension writes back into the form; it
    # looks kinks and infotags up by bare id.
    profile = json.loads(_zip(res.content).read("character.json"))
    assert profile["character"]["description"] == "[b]What F-list had before the Upload.[/b]"
    assert profile["kinks"] == {"580": "fave", "581": "no"}
    assert profile["infotags"] == {"2": "Human"}
    assert [k["name"] for k in profile["customKinks"]] == ["Lantern lore"]


def test_the_avatar_and_gallery_are_inside_the_backup_taken_before_an_upload(paired) -> None:
    client, extension = paired
    taken = _upload_starts(extension)

    res = client.get(f"/flist/character/42/zip-backups/{taken}/download")

    assert res.status_code == 200
    backup = _zip(res.content)
    assert backup.read("avatar.png") == AVATAR
    assert backup.read("images/17924625.png") == PNG


def test_the_avatar_is_inside_a_backup_made_in_the_window(paired) -> None:
    client, _extension = paired
    made = client.post("/flist/character/42/zip-backup").json()

    res = client.get(f"/flist/character/42/zip-backups/{made['filename']}/download")

    assert res.status_code == 200
    assert _zip(res.content).read("avatar.png") == AVATAR


# ---- Backups taken before an Upload by an earlier version ------------------

#: The name an earlier version gave the Backup before an Upload.
OLD_NAME = "pre-restore-2026-03-05T12-30-45.zip"
#: The same moment under the Backup file name the list recognises.
ADOPTED_NAME = "2026-03-05T123045Z.zip"


def _old_pre_upload_backup() -> bytes:
    """A Backup as an earlier version wrote it: the form state packed
    as-is, form field names and custom-kink list included, beside
    Live's gallery and the avatar. No backup-meta.json."""
    form_as_written = {
        "character": FORM_STATE["character"],
        "settings": FORM_STATE["settings"],
        "infotags": FORM_STATE["infotags"],
        "kinks": FORM_STATE["kinks"],
        "custom_kinks": FORM_STATE["customKinks"],
        "images": [
            {"image_id": "17924625", "extension": "png", "description": "Lantern", "sort_order": 0}
        ],
        "inlines": {},
    }
    profile = {
        "meta": {"exportedAt": "2026-03-05T12:30:45.000Z", "version": "0.0.0"},
        "character": {
            "id": "42",
            "name": NAME,
            "description": FORM_STATE["character"]["description"],
            "customTitle": "Keeper of Lanterns",
        },
        "settings": FORM_STATE["settings"],
        "infotags": FORM_STATE["infotags"],
        "kinks": FORM_STATE["kinks"],
        "customKinks": [],
        "images": {
            "list": [{"position": 0, "filename": "images/17924625.png", "description": "Lantern"}],
            "missing": [],
            "avatar": {"filename": "avatar.png"},
        },
        "inlines": [],
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("character.json", json.dumps(profile))
        zf.writestr("working.json", json.dumps(form_as_written))
        zf.writestr("images/17924625.png", PNG)
        zf.writestr("avatar.png", AVATAR)
    return buf.getvalue()


@pytest.fixture
def old_backup_on_disk(paired):
    import archive_backups

    data = _old_pre_upload_backup()
    (archive_backups.backups_dir("42") / OLD_NAME).write_bytes(data)
    return data


@pytest.fixture
def started(paired, old_backup_on_disk):
    """The app starting over the data folder, startup work included. A
    fresh app: each one's MCP session managers start only once."""
    import importlib

    import server

    importlib.reload(server)
    with app_client(server.app) as client:
        yield client


def test_an_old_backup_taken_before_an_upload_is_listed_after_startup(
    started, old_backup_on_disk
) -> None:
    import archive_backups

    listed = started.get("/flist/character/42/zip-backups").json()["backups"]

    assert [b["filename"] for b in listed] == [ADOPTED_NAME]
    # Not a byte lost: the file is the one that was there, renamed.
    adopted = archive_backups.backups_dir("42") / ADOPTED_NAME
    assert adopted.read_bytes() == old_backup_on_disk
    assert not (archive_backups.backups_dir("42") / OLD_NAME).exists()


def test_an_old_backup_taken_before_an_upload_restores(started) -> None:
    res = started.post(
        "/flist/character/42/workbench/load-backup", json={"filename": ADOPTED_NAME}
    )

    assert res.status_code == 200, res.text
    payload = _workbench_payload(started)

    assert payload["character"]["description"] == "[b]What F-list had before the Upload.[/b]"
    assert payload["kinks"] == {"580": "fave", "581": "no"}
    assert payload["infotags"] == {"2": "Human"}
    assert payload["custom_kinks"]["31712021"]["name"] == "Lantern lore"
    assert [i["image_id"] for i in payload["images"]] == ["17924625"]


def test_an_old_backup_taken_before_an_upload_can_be_browsed(started) -> None:
    res = started.get(f"/flist/character/42/zip-backups/{ADOPTED_NAME}/payload")

    assert res.status_code == 200, res.text
    assert res.json()["payload"]["kinks"] == {"580": "fave", "581": "no"}


def test_an_old_backup_taken_before_an_upload_is_an_upload_source_that_keeps_the_kinks(
    started, paired
) -> None:
    """The earlier version wrote the form's own field names into
    character.json. The extension looks kinks up by bare id, so it would
    have read every kink as unset and cleared them all on the form."""
    _client, extension = paired

    sources = extension.get("/restore/snapshots", params={"character": NAME}).json()
    assert ADOPTED_NAME in [s["id"] for s in sources]
    res = extension.get(f"/restore/snapshot/{ADOPTED_NAME}", params={"character": NAME})

    assert res.status_code == 200
    backup = _zip(res.content)
    profile = json.loads(backup.read("character.json"))
    assert profile["kinks"] == {"580": "fave", "581": "no"}
    assert profile["infotags"] == {"2": "Human"}
    assert [k["name"] for k in profile["customKinks"]] == ["Lantern lore"]
    assert backup.read("avatar.png") == AVATAR
    assert backup.read("images/17924625.png") == PNG


# ---- a Backup whose images could not be packed -------------------------


@pytest.fixture
def images_fail_to_pack(paired, monkeypatch: pytest.MonkeyPatch):
    """Packing the gallery fails once (a locked file, say); the Backup is
    then taken without the image files."""
    import restore as restore_svc

    real = restore_svc.zip_serialise.build_zip
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("the image file is locked")
        return real(*args, **kwargs)

    monkeypatch.setattr(restore_svc.zip_serialise, "build_zip", flaky)
    return paired


def test_a_backup_without_its_images_is_refused_as_an_upload_source(
    images_fail_to_pack,
) -> None:
    client, extension = images_fail_to_pack
    taken = _upload_starts(extension)

    # Still a Backup, and still the way back into the Workbench: its
    # working.json lists the gallery, whose files are in the pool.
    assert [b["filename"] for b in client.get("/flist/character/42/zip-backups").json()["backups"]] == [taken]
    res = client.post("/flist/character/42/workbench/load-backup", json={"filename": taken})
    assert res.status_code == 200, res.text
    assert [i["image_id"] for i in _workbench_payload(client)["images"]] == ["17924625"]

    # Uploaded, its empty gallery would read as "remove every image".
    sources = extension.get("/restore/snapshots", params={"character": NAME}).json()
    [offered] = [s for s in sources if s["id"] == taken]
    assert "image" in offered["upload_refused"]
    assert all(s.get("upload_refused") is None for s in sources if s["id"] != taken)
    fetched = extension.get(f"/restore/snapshot/{taken}", params={"character": NAME})
    assert fetched.status_code == 409
    assert fetched.json()["code"] == "backup_not_uploadable"
    assert "image" in fetched.json()["message"]
