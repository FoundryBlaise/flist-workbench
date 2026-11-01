"""Every refusal answers `{code, message}`.

The app window, the extension and MCP tooling show the reason a request
was turned down without special cases, so the sidecar answers each
refusal in that one shape, with a code a caller can switch on. These
tests call the sidecar from outside, the way the app window does.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fchat_logs import chat, utc, write_log
from sidecar_client import app_client


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import character_archive

    importlib.reload(character_archive)
    import server

    return app_client(server.app)


@pytest.fixture
def fchat(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An F-Chat folder holding one Log: `me` talking to `partner`."""
    root = tmp_path / "fchat"
    write_log(root / "me" / "logs" / "partner", [chat("Partner", "hello", at=utc(2026, 1, 1))])
    monkeypatch.setenv("FCHAT_DATA_DIR", str(root))
    return root


# ---- Logs --------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "/logs/partners?char=nobody",
        "/logs/messages?char=me&partner=stranger",
        "/logs/messages?char=nobody&partner=partner",
        "/logs/search?char=me&partner=stranger&q=hello",
        "/logs/search_all?char=nobody&q=hello",
    ],
)
def test_an_unknown_log_is_refused_as_log_not_found(
    client: TestClient, fchat: Path, url: str
) -> None:
    res = client.get(url)
    assert res.status_code == 404, res.text
    assert set(res.json()) == {"code", "message"}
    assert res.json()["code"] == "log_not_found"


@pytest.mark.parametrize(
    "url",
    [
        "/logs/partners?char=..",
        "/logs/partners?char=me%5C..",
        "/logs/messages?char=..&partner=partner",
        "/logs/messages?char=me&partner=..",
        "/logs/messages?char=me&partner=a%2Fb",
        "/logs/search?char=me&partner=..%5Cpartner&q=hello",
        "/logs/search_all?char=..&q=hello",
    ],
)
def test_a_log_name_that_cannot_name_a_file_is_refused_as_invalid_file_name(
    client: TestClient, fchat: Path, url: str
) -> None:
    res = client.get(url)
    assert res.status_code == 400, res.text
    assert set(res.json()) == {"code", "message"}
    assert res.json()["code"] == "invalid_file_name"


# ---- Backup file names -------------------------------------------------------


@pytest.fixture
def character(client: TestClient) -> str:
    """A character in the archive, with an empty backups folder."""
    import json

    import character_archive

    char = character_archive.character_dir("123")
    (char / "live.json").write_text(json.dumps({"id": 123, "name": "Someone"}), encoding="utf-8")
    character_archive.backups_dir("123")
    return "123"


@pytest.mark.parametrize(
    ("method", "suffix", "body"),
    [
        ("GET", "zip-backups/{name}/payload", None),
        ("GET", "zip-backups/{name}/download", None),
        ("DELETE", "zip-backups/{name}", None),
        ("PATCH", "zip-backups/{name}", {"name": "renamed"}),
        ("POST", "zip-backups/{name}/create-set", {"name": "from backup"}),
        ("POST", "workbench/load-backup", {"filename": "{name}"}),
    ],
)
@pytest.mark.parametrize("name", ["not-a-backup.zip", "..%5Coutside.zip"])
def test_a_backup_name_that_is_not_one_is_refused_as_invalid_file_name(
    client: TestClient, character: str, method: str, suffix: str, body: dict | None, name: str
) -> None:
    if body is not None:
        body = {k: v.replace("{name}", name) for k, v in body.items()}
    res = client.request(
        method, f"/flist/character/{character}/{suffix.replace('{name}', name)}", json=body
    )
    assert res.status_code == 400, res.text
    assert set(res.json()) == {"code", "message"}
    assert res.json()["code"] == "invalid_file_name"


@pytest.mark.parametrize("folder", ["images", "trash", "inlines"])
@pytest.mark.parametrize("name", ["..%5Clive.json", "no-extension"])
def test_an_image_name_that_is_not_one_is_refused_as_invalid_file_name(
    client: TestClient, character: str, folder: str, name: str
) -> None:
    res = client.get(f"/flist/character/{character}/{folder}/{name}")
    assert res.status_code == 400, res.text
    assert set(res.json()) == {"code", "message"}
    assert res.json()["code"] == "invalid_file_name"


@pytest.mark.parametrize(
    ("method", "url", "body"),
    [
        ("GET", "/labels/stats?char=me&partner=stranger", None),
        ("GET", "/labels/stats-all?char=nobody", None),
        ("POST", "/labels/fill-unlabeled", {"character": "me", "partner": "stranger", "label": "IC"}),
    ],
)
def test_the_label_routes_refuse_an_unknown_log_the_same_way(
    client: TestClient, fchat: Path, method: str, url: str, body: dict | None
) -> None:
    res = client.request(method, url, json=body)
    assert res.status_code == 404, res.text
    assert set(res.json()) == {"code", "message"}
    assert res.json()["code"] == "log_not_found"
