"""Errors have one shape, wherever they come from.

Every error the REST surface answers is `{code, message, details}`:
a code a caller can switch on, a message to show, and an object with
whatever else the situation carries (the etag on disk, the field that
was wrong). Nothing is nested a second time. A code means one
situation, so it answers with one status on every route. MCP tools
report the same code and details as the REST error for the same
situation, and a Pull that fails says so with the same three fields.

The sweeps take the routes from the app itself, grouped by the router
that declares them, so a route added later is covered without touching
this file.
"""

from __future__ import annotations

import json
import re
import zipfile
from collections import defaultdict
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mcp_helpers import call_tool, mcp_client, tool_error_text
from sidecar_client import api_routes, app_client, is_refusal_shaped, sweep

CID = "42"
NAME = "Mira Thornfield"

#: Routes a sweep cannot call once and move on from: the event stream
#: never ends, and the render long-poll waits for the window to draw.
#: `POST /shutdown` is swept: in-process there is no server loop of the
#: app's to end, so it refuses (409 `not_stoppable`) and nothing stops.
UNSWEPT = {("GET", "/events"), ("GET", "/render/requests")}

#: What fills the path of every swept route: a character the archive
#: does not hold, then one it does, and names that name nothing.
PATH_PARAMS = [
    {"character_id": "123", "name": "Nobody", "filename": "x"},
    {"character_id": CID, "name": NAME, "filename": "2026-01-01T000000Z.zip"},
]


@pytest.fixture
def archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN201
    """An archive holding one pulled character; no F-Chat folder."""
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "no-fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import archive_live
    import archive_registry
    import restore as restore_svc

    importlib.reload(archive_registry)
    importlib.reload(restore_svc)
    archive_registry.register_character(CID, NAME)
    archive_live.write_live(CID, {"id": int(CID), "name": NAME, "character": {"name": NAME}})
    yield
    restore_svc.revoke_token()


@pytest.fixture
def client(archive) -> TestClient:  # noqa: ANN001
    import server

    return app_client(server.app)


def _too_old_backup() -> str:
    """A Backup from before the app stored a loadable profile in it."""
    import archive_backups

    name = "2026-01-01T000000Z.zip"
    with zipfile.ZipFile(archive_backups.backups_dir(CID) / name, "w") as zf:
        zf.writestr("character.json", "{}")
    return name


# ---- REST --------------------------------------------------------------------


@pytest.mark.httpx_mock(assert_all_requests_were_expected=False)
def test_every_route_group_answers_its_errors_in_one_shape(
    archive, httpx_mock  # noqa: ANN001 - F-list answers nothing
) -> None:
    import server

    # A route that fails outright must still answer in the shape, so
    # the client hears the 500 rather than re-raising it.
    client = app_client(server.app, raise_server_exceptions=False)
    routes = [r for r in api_routes(client.app) if (r.method, r.path) not in UNSWEPT]
    groups = {r.group for r in routes}
    refused: set[str] = set()
    statuses: dict[str, set[int]] = defaultdict(set)
    failures: list[str] = []

    for params in PATH_PARAMS:
        for route in routes:

            def note(res, group=route.group) -> bool:  # noqa: ANN001
                if res.status_code >= 400 and is_refusal_shaped(res):
                    refused.add(group)
                    statuses[res.json()["code"]].add(res.status_code)
                return True

            # A JSON array is never a valid body, so a route that takes
            # one refuses it before doing anything.
            failures += sweep(client, [route], note, json=[], **params)

    assert failures == []
    assert groups - refused == set()
    # The sweep asked the sidecar to stop and was refused, so it is
    # still the one answering here.
    assert statuses["not_stoppable"] == {409}
    assert {code: s for code, s in statuses.items() if len(s) > 1} == {}


def test_a_foreign_error_is_not_nested(client: TestClient) -> None:
    res = client.get("/foreign/search", params={"source": "bookmarks"})
    assert res.status_code == 401, res.text
    assert res.json() == {
        "code": "not_signed_in",
        "message": res.json()["message"],
        "details": {},
    }


def test_a_request_the_app_cannot_bind_lists_what_was_wrong_in_details(
    client: TestClient,
) -> None:
    res = client.put("/settings", json=[])
    assert res.status_code == 422, res.text
    assert is_refusal_shaped(res)
    assert res.json()["code"] == "invalid_request"
    assert res.json()["details"]["errors"]


def test_a_backup_too_old_to_load_answers_the_same_on_every_route(
    client: TestClient,
) -> None:
    name = _too_old_backup()

    browsed = client.get(f"/flist/character/{CID}/zip-backups/{name}/payload")
    loaded = client.post(f"/flist/character/{CID}/workbench/load-backup", json={"filename": name})

    for res in (browsed, loaded):
        assert res.status_code == 409, res.text
        assert is_refusal_shaped(res)
        assert res.json()["code"] == "backup_too_old"
    assert browsed.json() == loaded.json()


def test_a_stale_workbench_save_carries_the_etag_on_disk_in_details(
    client: TestClient,
) -> None:
    read = client.get(f"/flist/character/{CID}/workbench/payload").json()

    res = client.put(
        f"/flist/character/{CID}/workbench/payload",
        json=read["payload"],
        headers={"If-Match": "0" * 64},
    )

    assert res.status_code == 409, res.text
    assert is_refusal_shaped(res)
    assert res.json()["code"] == "etag_mismatch"
    assert res.json()["details"] == {"current_etag": read["etag"]}


# ---- MCP ---------------------------------------------------------------------


def _tool_error(result) -> tuple[str, dict]:  # noqa: ANN001
    """The code and details of a failed tool call, which the SDK reports
    as `Error executing tool <name>: <code>: <message> {details}`."""
    text = re.sub(r"^Error executing tool \w+: ", "", tool_error_text(result))
    code, _, rest = text.partition(": ")
    brace = rest.find(" {")
    details = json.loads(rest[brace + 1 :]) if brace >= 0 else {}
    return code, details


async def test_mcp_reports_a_too_old_backup_as_rest_does(
    client: TestClient,
) -> None:
    name = _too_old_backup()
    rest = client.post(f"/flist/character/{CID}/workbench/load-backup", json={"filename": name})

    async with mcp_client() as session:
        result, _ = await call_tool(
            session, "load_backup_into_workbench", character=NAME, backup=name, confirm=True
        )

    assert _tool_error(result) == (rest.json()["code"], rest.json()["details"])


async def test_mcp_reports_a_stale_workbench_write_as_rest_does(
    client: TestClient,
) -> None:
    read = client.get(f"/flist/character/{CID}/workbench/payload").json()
    rest = client.put(
        f"/flist/character/{CID}/workbench/payload",
        json=read["payload"],
        headers={"If-Match": "0" * 64},
    )

    async with mcp_client() as session:
        result, _ = await call_tool(
            session,
            "put_workbench_payload",
            character=NAME,
            payload=read["payload"],
            if_match="0" * 64,
            confirm=True,
        )

    assert _tool_error(result) == (rest.json()["code"], rest.json()["details"])


# ---- Pull stream -------------------------------------------------------------


def test_a_pull_that_cannot_start_reports_code_message_and_details(
    client: TestClient,
) -> None:
    res = client.post(f"/flist/character/{NAME}/pull")
    assert res.status_code == 200
    events = [
        (block.split("\n")[0].removeprefix("event: "), json.loads(block.split("data: ", 1)[1]))
        for block in res.text.strip().split("\n\n")
    ]
    name, data = events[-1]
    assert name == "error"
    assert data["stage"] == "ticket"
    assert data["code"] == "not_signed_in"
    assert isinstance(data["message"], str)
    assert data["details"] == {}
