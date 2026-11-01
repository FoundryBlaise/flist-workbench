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

    import character_archive
    import paths
    import restore as restore_svc
    import server

    importlib.reload(paths)
    importlib.reload(character_archive)
    importlib.reload(restore_svc)

    character_archive.register_character("42", NAME)
    character_archive.write_live(
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
    (character_archive.images_dir("42") / "17924625.png").write_bytes(PNG)
    avatar = character_archive.avatar_path_for(NAME)
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
    bench = client.get("/flist/character/42/workbench").json()["workbench"]
    return client.get(f"/flist/character/42/sets/{bench['id']}/payload").json()["payload"]


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
