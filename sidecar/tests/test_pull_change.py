"""A Pull says whether F-list changed, and leaves no copy behind.

A Pull writes Live and nothing else of the profile: no extra copy of
Live piles up per Pull. Whether anything changed is judged against the
Live the Pull replaces, ignoring when it was fetched. Back up all pulls
the same way and keeps what changed as a Backup, nothing more.

F-list is faked at the HTTP seam; everything else is the real app.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sidecar_client import app_client, disk_tree

NAME = "Corin Ashvale"
CID = 5150
FIRST = "[b]First words.[/b]"
SECOND = "[b]Second thoughts.[/b]"


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    data = tmp_path / "data"
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(data))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import archive_registry
    import paths
    from services import upload as upload_service

    importlib.reload(paths)
    importlib.reload(archive_registry)
    importlib.reload(upload_service)
    yield data
    upload_service.revoke_token()


@pytest.fixture
def client(data_dir: Path) -> TestClient:
    import server

    return app_client(server.app)


@pytest.fixture
def flist(httpx_mock):  # noqa: ANN001, ANN201
    """Signed in; `flist["description"]` is what F-list serves now."""
    import flist_api

    flist_api.ticket_store().set(
        flist_api.Ticket(
            account="corin-account",
            value="test-ticket",
            password="test-password",
            acquired_at=time.monotonic(),
        ),
        characters=[{"id": CID, "name": NAME}],
    )
    state = {"description": FIRST}

    def character_data(request):  # noqa: ANN001, ANN202
        import httpx

        return httpx.Response(
            200,
            json={
                "error": "",
                "id": CID,
                "name": NAME,
                "description": state["description"],
                "infotags": {},
                "kinks": {},
                "custom_kinks": {},
                "inlines": {},
                "images": [],
            },
        )

    httpx_mock.add_callback(
        character_data, url=flist_api.CHARACTER_DATA_URL, method="POST", is_reusable=True
    )
    httpx_mock.add_response(
        url=flist_api.avatar_url(NAME),
        method="GET",
        content=b"\x89PNG\r\n\x1a\n" + b"avatar" * 8,
        is_optional=True,
        is_reusable=True,
    )
    yield state
    flist_api.ticket_store().clear()


def events(client: TestClient, path: str) -> list[tuple[str, dict]]:
    with client.stream("POST", path) as res:
        body = "".join(res.iter_text())
    out = []
    for block in body.split("\n\n"):
        lines = dict(
            line.split(": ", 1) for line in block.splitlines() if ": " in line
        )
        if "event" in lines:
            out.append((lines["event"], json.loads(lines.get("data") or "{}")))
    assert out and out[-1][0] == "done", body
    return out


def pull(client: TestClient) -> dict:
    return events(client, f"/flist/character/{NAME}/pull")[-1][1]


def folder() -> Path:
    import archive_registry

    return archive_registry.character_dir(CID)


def profile_files() -> set[str]:
    """Every JSON file under the character's folder: copies of the
    profile, not the image bytes."""
    return {
        p.relative_to(folder()).as_posix()
        for p in folder().rglob("*.json")
        if p.name != "pull_state.json"
    }


def test_a_first_pull_reports_a_change_and_writes_only_live(
    client: TestClient, flist  # noqa: ANN001
) -> None:
    done = pull(client)

    assert done["changed"] is True
    assert profile_files() == {"live.json"}


def test_a_pull_of_an_unchanged_profile_reports_no_change_and_adds_nothing(
    client: TestClient, flist  # noqa: ANN001
) -> None:
    pull(client)
    before = disk_tree(folder())

    done = pull(client)

    assert done["changed"] is False
    assert disk_tree(folder()) == before


def test_a_pull_of_a_changed_profile_reports_the_change_and_keeps_one_live(
    client: TestClient, flist  # noqa: ANN001
) -> None:
    pull(client)
    flist["description"] = SECOND

    done = pull(client)

    assert done["changed"] is True
    assert profile_files() == {"live.json"}
    live = client.get(f"/flist/character/{CID}/live").json()
    assert SECOND in json.dumps(live)


def test_back_up_all_keeps_a_backup_and_no_other_copy(
    client: TestClient, flist  # noqa: ANN001
) -> None:
    events(client, "/flist/backup-all")
    flist["description"] = SECOND
    events(client, "/flist/backup-all")

    files = profile_files()
    assert files == {"live.json"}
    backups = client.get(f"/flist/character/{CID}/zip-backups").json()["backups"]
    assert len(backups) == 2


@pytest.mark.parametrize(
    ("method", "suffix"),
    [
        ("POST", "snapshot"),
        ("GET", "snapshots"),
        ("GET", "snapshots/1000.json"),
    ],
)
def test_the_routes_for_copies_of_live_are_gone_and_touch_nothing(
    client: TestClient, flist, method: str, suffix: str  # noqa: ANN001
) -> None:
    pull(client)
    # An earlier version's copy of Live is still on disk; asking for it
    # neither reads nor moves it.
    old = folder() / "snapshots" / "1000.json"
    old.parent.mkdir()
    old.write_text('{"character": {"name": "Corin Ashvale"}}', encoding="utf-8")
    before = disk_tree(folder())

    res = client.request(method, f"/flist/character/{CID}/{suffix}")

    assert res.status_code == 404
    assert disk_tree(folder()) == before
