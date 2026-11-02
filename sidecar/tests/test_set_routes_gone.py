"""A character has one Workbench, so the REST API offers nothing that
lists, names, copies, deletes or switches between several, and nothing
that packs one up for another install or brings one in. Each of those
routes answers 404, and asking changes nothing on disk.
"""

from __future__ import annotations

import importlib
import io
import zipfile
from pathlib import Path

import pytest
from sidecar_client import app_client, disk_tree

NAME = "Wren Ashdown"
CID = "42"


@pytest.fixture
def sidecar(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)

    import archive_backups
    import archive_live
    import archive_registry
    import archive_workbench
    import paths
    import server

    importlib.reload(paths)
    importlib.reload(archive_registry)

    archive_registry.register_character(CID, NAME)
    archive_live.write_live(
        CID,
        {
            "character": {"id": 42, "name": NAME, "description": "Published."},
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1000,
        },
    )
    api = app_client(server.app)
    # A Workbench and a Backup exist, so a 404 means the route is gone,
    # not that there was nothing for it to act on.
    archive_workbench.read_workbench(CID, create=True)
    # The id a draft had in older versions, as an old window would send it.
    bench_id = "aaaaaaaaaaaa"
    backup = archive_backups.save_zip_backup(
        CID, source="workbench", occasion="manual", force=True
    )
    return api, tmp_path, bench_id, backup["filename"]


def _bundle() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", "{}")
    return buf.getvalue()


def _gone_requests(bench_id: str, backup: str):
    base = f"/flist/character/{CID}"
    return [
        ("GET", f"{base}/sets", {}),
        ("POST", f"{base}/sets", {"json": {"name": "Second"}}),
        ("PATCH", f"{base}/sets/{bench_id}", {"json": {"name": "Renamed"}}),
        ("DELETE", f"{base}/sets/{bench_id}", {}),
        ("POST", f"{base}/sets/{bench_id}/duplicate", {"json": {"name": "Copy"}}),
        ("POST", f"{base}/sets/{bench_id}/activate", {}),
        ("POST", f"{base}/from-flist/activate", {}),
        ("GET", f"{base}/sets/{bench_id}/payload", {}),
        ("PUT", f"{base}/sets/{bench_id}/payload", {"json": {"character": {}}}),
        ("GET", f"{base}/sets/{bench_id}/export", {}),
        (
            "POST",
            f"{base}/sets/import",
            {
                "files": {"zip": ("b.zip", _bundle(), "application/zip")},
                "data": {"name": "Imported", "confirm_cross_character": "true"},
            },
        ),
        (
            "POST",
            f"{base}/zip-backups/{backup}/create-set",
            {"json": {"name": "From a Backup"}},
        ),
    ]


def test_every_set_and_bundle_route_answers_404_and_changes_nothing(sidecar) -> None:
    api, root, bench_id, backup = sidecar
    before = disk_tree(root)

    answers = {
        f"{method} {url}": api.request(method, url, **kw).status_code
        for method, url, kw in _gone_requests(bench_id, backup)
    }

    assert answers == {key: 404 for key in answers}
    assert disk_tree(root) == before


def test_importing_onto_a_character_the_archive_lacks_creates_nothing(
    sidecar,
) -> None:
    api, root, _, _ = sidecar

    res = api.post(
        "/flist/character/7777/sets/import",
        files={"zip": ("b.zip", _bundle(), "application/zip")},
        data={"name": "Imported", "confirm_cross_character": "true"},
    )

    assert res.status_code == 404
    assert not (root / "characters" / "7777").exists()
