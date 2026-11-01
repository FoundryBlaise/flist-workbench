"""A character id or file name from a request never leaves the archive.

Every route under `/flist/character/{character_id}/` turns the id into
a folder. A registered id maps to the folder the registry names; an
unregistered one used to be joined onto the archive root as given, and
the folder created. With `..` and an encoded backslash, which Windows
treats as a separator, that escaped the archive. These tests send such
ids and file names the way a request would, and check both the answer
and that nothing on disk changed (ADR 0002).
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sidecar_client import (
    api_routes,
    app_client,
    character_routes,
    disk_tree,
    error_code,
    sweep,
)

#: Each is percent-encoded the way it would arrive in a URL path.
HOSTILE_IDS = [
    "%2E%2E",
    "..%5C..%5Cescaped",
    "..%5Cescaped",
    "a%5Cb",
    ".hidden",
    "CON",
    "_registry.json",
    "trailing.",
]


@pytest.fixture
def archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN201
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import character_archive
    import restore as restore_svc

    importlib.reload(character_archive)
    importlib.reload(restore_svc)
    character_archive.root()
    yield character_archive
    restore_svc.revoke_token()


@pytest.fixture
def client(archive) -> TestClient:  # noqa: ANN001
    import server

    return app_client(server.app)


def test_no_character_route_accepts_a_hostile_id_or_touches_the_disk(
    client: TestClient, tmp_path: Path
) -> None:
    before = disk_tree(tmp_path)
    routes = character_routes(client.app)
    assert len(routes) > 30
    accepted = []
    for cid in HOSTILE_IDS:
        accepted += sweep(
            client,
            routes,
            lambda res: res.status_code == 400 and error_code(res) == "invalid_character_id",
            json={},
            character_id=cid,
        )
    assert accepted == []
    assert disk_tree(tmp_path) == before


@pytest.mark.parametrize("cid", HOSTILE_IDS)
@pytest.mark.parametrize(
    "suffix", ["live", "workbench", "images", "zip-backups", "trash", "snapshots"]
)
def test_a_hostile_id_is_refused_by_name(client: TestClient, cid: str, suffix: str) -> None:
    res = client.get(f"/flist/character/{cid}/{suffix}")
    assert res.status_code == 400, res.text
    assert res.json()["code"] == "invalid_character_id"


def test_the_archive_refuses_a_hostile_id_directly(archive) -> None:  # noqa: ANN001
    """The rule lives where the id becomes a path, so MCP tools and
    services that bypass the routes are held to it too."""
    for cid in ["..", "..\\..\\escaped", "a/b", "CON", "_registry.json", ""]:
        with pytest.raises(archive.InvalidCharacterId):
            archive.character_dir(cid)


def test_a_real_id_still_works(client: TestClient) -> None:
    assert client.get("/flist/character/123/zip-backups").status_code == 200


def _zip_with_working(payload: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("working.json", json.dumps(payload))
    return buf.getvalue()


def test_the_backup_payload_route_checks_the_file_name(
    client: TestClient, archive  # noqa: ANN001
) -> None:
    """A zip next to backups/, not in it, must not be readable."""
    char = archive.character_dir("123")
    (char / "outside.zip").write_bytes(_zip_with_working({"secret": True}))
    res = client.get("/flist/character/123/zip-backups/..%5Coutside.zip/payload")
    assert res.status_code == 400
    assert "secret" not in res.text


def _pair(client: TestClient) -> dict[str, str]:
    begun = client.post("/restore/handshake").json()
    client.post("/restore/handshake/accept", json={"handshake_id": begun["handshake_id"]})
    return {"X-Workbench-Auth": begun["token"]}


def _archive_character(archive, name: str = "Someone") -> Path:  # noqa: ANN001
    char = archive.character_dir("123")
    (char / "live.json").write_text(json.dumps({"id": 123, "name": name}), encoding="utf-8")
    return char


@pytest.mark.parametrize(
    "snapshot_id", ["..%5Coutside.zip", "..%5C..%5Coutside.zip", "outside.zip"]
)
def test_upload_resolves_a_source_only_among_listed_backups(
    client: TestClient, archive, snapshot_id: str  # noqa: ANN001
) -> None:
    char = _archive_character(archive)
    (char / "outside.zip").write_bytes(b"PK not a backup")
    archive.backups_dir("123")
    (char / "backups" / "outside.zip").write_bytes(b"PK not listed either")
    res = client.get(
        f"/restore/snapshot/{snapshot_id}",
        params={"character": "Someone"},
        headers=_pair(client),
    )
    assert res.status_code == 404


def test_upload_still_serves_a_listed_backup(client: TestClient, archive) -> None:  # noqa: ANN001
    char = _archive_character(archive)
    name = "2026-10-01T120000Z.zip"
    (char / "backups").mkdir(exist_ok=True)
    (char / "backups" / name).write_bytes(_zip_with_working({}))
    res = client.get(
        f"/restore/snapshot/{name}", params={"character": "Someone"}, headers=_pair(client)
    )
    assert res.status_code == 200
    assert res.content.startswith(b"PK")


# ---- Log names ---------------------------------------------------------------
#
# The Logs routes name a character folder and a partner file under the
# F-Chat folder. Those names come from the request too.


@pytest.fixture
def fchat(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An F-Chat folder, and a Log-shaped file just outside it."""
    from fchat_logs import chat, utc, write_log

    root = tmp_path / "fchat"
    write_log(root / "me" / "logs" / "partner", [chat("Partner", "hello", at=utc(2026, 1, 1))])
    write_log(tmp_path / "logs" / "victim", [chat("Victim", "private", at=utc(2026, 1, 1))])
    monkeypatch.setenv("FCHAT_DATA_DIR", str(root))
    return root


@pytest.mark.parametrize("char", ["..", "me%5C..%5C..", "..%5C"])
def test_a_log_character_outside_the_fchat_folder_is_refused(
    client: TestClient, fchat: Path, char: str
) -> None:
    res = client.get(f"/logs/partners?char={char}")
    assert res.status_code == 400
    assert error_code(res) == "invalid_file_name"
    assert "victim" not in res.text


@pytest.mark.parametrize(
    ("char", "partner"),
    [("..", "victim"), ("me", "..%5C..%5C..%5Clogs%5Cvictim"), ("me", "..")],
)
def test_a_log_outside_the_fchat_folder_is_not_read(
    client: TestClient, fchat: Path, char: str, partner: str
) -> None:
    for path in ("/logs/messages", "/logs/search"):
        res = client.get(f"{path}?char={char}&partner={partner}&q=private")
        assert res.status_code == 400, f"{path}: {res.text}"
        assert error_code(res) == "invalid_file_name"
        assert "private" not in res.text


def test_a_real_log_still_reads(client: TestClient, fchat: Path) -> None:
    res = client.get("/logs/messages?char=me&partner=partner")
    assert res.status_code == 200
    assert "hello" in res.text


# ---- Whole names -------------------------------------------------------------
#
# A pattern anchored with `$` also matches just before one trailing
# newline, so `123\n` used to pass the id check: on Windows the folder
# could not be made (500), elsewhere an oddly named one appeared. Every
# name check matches the whole name instead.

#: A good id or name with a newline after it, percent-encoded for a URL path.
NEWLINE_IDS = ["123%0A", "Someone%0A"]
BACKUP_NAME = "2026-10-01T120000Z.zip"


def _pulled_character(archive) -> None:  # noqa: ANN001
    """Character `123`, as a Pull leaves it, with one Backup."""
    archive.write_live("123", {"id": 123, "name": "Someone"})
    char = archive.character_dir("123")
    archive.backups_dir("123")
    (char / "backups" / BACKUP_NAME).write_bytes(_zip_with_working({"a": 1}))


def _refused_as(code: str):  # noqa: ANN202
    return lambda res: res.status_code == 400 and error_code(res) == code


def test_a_character_id_ending_in_a_newline_is_refused_on_every_route(
    client: TestClient, tmp_path: Path
) -> None:
    before = disk_tree(tmp_path)
    failures = []
    for cid in NEWLINE_IDS:
        failures += sweep(
            client,
            character_routes(client.app),
            _refused_as("invalid_character_id"),
            json={},
            character_id=cid,
        )
    assert failures == []
    assert disk_tree(tmp_path) == before


def test_the_archive_refuses_an_id_ending_in_a_newline_directly(archive) -> None:  # noqa: ANN001
    with pytest.raises(archive.InvalidCharacterId):
        archive.character_dir("123\n")


def test_a_file_name_ending_in_a_newline_is_refused_on_every_route(
    client: TestClient, archive, tmp_path: Path  # noqa: ANN001
) -> None:
    """Backup, image, trash and inline names alike: 400 `invalid_file_name`."""
    _pulled_character(archive)
    routes = [
        r for r in api_routes(client.app, param="filename") if "/snapshots/" not in r.path
    ]
    assert any("/zip-backups/" in r.path for r in routes)
    before = disk_tree(tmp_path)
    failures = []
    for name in (f"{BACKUP_NAME}%0A", "1.png%0A"):
        failures += sweep(
            client,
            routes,
            _refused_as("invalid_file_name"),
            json={"name": "From backup"},
            character_id="123",
            filename=name,
        )
    assert failures == []
    assert disk_tree(tmp_path) == before


def test_a_backup_name_ending_in_a_newline_is_refused_by_the_archive(archive) -> None:  # noqa: ANN001
    with pytest.raises(archive.InvalidFileName):
        archive.require_backup_filename(f"{BACKUP_NAME}\n")


def test_a_snapshot_name_ending_in_a_newline_is_not_found(
    client: TestClient, archive  # noqa: ANN001
) -> None:
    _pulled_character(archive)
    res = client.get("/flist/character/123/snapshots/1.json%0A")
    assert res.status_code == 404


def test_an_image_id_ending_in_a_newline_is_refused(client: TestClient, archive) -> None:  # noqa: ANN001
    _pulled_character(archive)
    res = client.get("/flist/character/123/image/1%0A")
    assert res.status_code == 400, res.text


@pytest.mark.parametrize(
    ("char", "partner"), [("me%0A", "partner"), ("me", "partner%0A")]
)
def test_a_log_name_ending_in_a_newline_is_refused(
    client: TestClient, fchat: Path, char: str, partner: str
) -> None:
    for path in ("/logs/messages", "/logs/search"):
        res = client.get(f"{path}?char={char}&partner={partner}&q=hello")
        assert res.status_code == 400, f"{path}: {res.text}"
        assert error_code(res) == "invalid_file_name"


def test_valid_names_still_work(client: TestClient, archive) -> None:  # noqa: ANN001
    _pulled_character(archive)
    assert client.get(f"/flist/character/123/zip-backups/{BACKUP_NAME}/payload").status_code == 200
    assert client.get("/flist/character/123/zip-backups").status_code == 200
