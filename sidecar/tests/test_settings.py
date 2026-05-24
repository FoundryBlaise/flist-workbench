from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # Pin the documents DB to a tmp dir AND clear FCHAT_DATA_DIR so
    # the settings store, not the env var, drives the resolved path.
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    from server import app

    return TestClient(app)


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
    client = TestClient(server_module.app)

    # Set a different value via settings; effective should stay pinned
    # to the env var because that wins in data_dir().
    other = tmp_path / "other"
    other.mkdir()
    client.put("/settings", json={"fchat_data_dir": str(other)})
    res = client.get("/settings").json()
    assert res["fchat_data_dir_env_locked"] is True
    assert res["fchat_data_dir_effective"] == str(pinned)
