from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sidecar_client import app_client


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # Pin the documents DB to a tmp dir AND clear FCHAT_DATA_DIR so
    # the settings store, not the env var, drives the resolved path.
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    from server import app

    return app_client(app)


def test_get_settings_returns_defaults(client: TestClient) -> None:
    res = client.get("/settings").json()
    assert res["fchat_data_dir"] is None
    # Default `/sideprojects/rag/data` may or may not exist in the
    # test env — what matters is the key is a string and not env-pinned.
    assert isinstance(res["fchat_data_dir_effective"], str)
    assert res["fchat_data_dir_env_locked"] is False


def test_put_sets_data_dir(tmp_path: Path, client: TestClient) -> None:
    target = tmp_path / "logs"
    target.mkdir()
    res = client.put("/settings", json={"fchat_data_dir": str(target)})
    assert res.status_code == 200
    body = res.json()
    assert body["fchat_data_dir"] == str(target)
    assert body["fchat_data_dir_effective"] == str(target)


def test_put_rejects_nonexistent_dir(client: TestClient) -> None:
    res = client.put("/settings", json={"fchat_data_dir": "/nope/does/not/exist"})
    assert res.status_code == 400


def test_put_clears_with_empty_string(tmp_path: Path, client: TestClient) -> None:
    target = tmp_path / "logs"
    target.mkdir()
    client.put("/settings", json={"fchat_data_dir": str(target)})
    res = client.put("/settings", json={"fchat_data_dir": ""}).json()
    assert res["fchat_data_dir"] is None


def test_env_var_locks_setting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pinned = tmp_path / "pinned"
    pinned.mkdir()
    monkeypatch.setenv("FCHAT_DATA_DIR", str(pinned))
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    # Re-import server fresh so the route closures pick up the env.
    import importlib
    import server as server_module

    importlib.reload(server_module)
    client = app_client(server_module.app)

    # Set a different value via settings; effective should stay pinned
    # to the env var because that wins in data_dir().
    other = tmp_path / "other"
    other.mkdir()
    client.put("/settings", json={"fchat_data_dir": str(other)})
    res = client.get("/settings").json()
    assert res["fchat_data_dir_env_locked"] is True
    assert res["fchat_data_dir_effective"] == str(pinned)


def test_settings_offer_no_backup_schedule_or_retention(client: TestClient) -> None:
    # Scheduled backups are gone: neither an interval nor a number of
    # Backups to keep is a setting any more.
    res = client.get("/settings").json()
    assert "backups" not in res


def test_saving_old_backup_schedule_keys_is_ignored(client: TestClient) -> None:
    # A window from an older release may still send the removed block.
    res = client.put(
        "/settings",
        json={
            "backups": {"scheduled_interval_days": 3, "scheduled_keep_last_n": 2}
        },
    )
    assert res.status_code == 200
    assert "backups" not in res.json()
    assert "backups" not in client.get("/settings").json()


def test_startup_leaves_an_old_documents_database_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The one-off move of settings out of documents.db is gone: its rows
    # are not read, and the file is neither changed nor deleted.
    import sqlite3

    data_dir = tmp_path / "wb"
    data_dir.mkdir()
    logs_dir = tmp_path / "logs"
    logs_dir.mkdir()
    legacy = data_dir / "documents.db"
    db = sqlite3.connect(legacy)
    db.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.execute(
        "INSERT INTO settings VALUES ('fchat_data_dir', ?)", (str(logs_dir),)
    )
    db.commit()
    db.close()
    before = legacy.read_bytes()

    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(data_dir))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    from server import app

    res = app_client(app).get("/settings").json()
    assert res["fchat_data_dir"] is None
    assert legacy.read_bytes() == before
