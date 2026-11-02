"""Settings change through one service, whoever asks.

The window changes settings over REST, a model over MCP. Both reach
the same service, so a value is refused or clamped the same way from
either side, and a change a model makes reaches the window as a
`settings-changed` event instead of waiting for a reload.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mcp_helpers import call_tool, mcp_client
from sidecar_client import app_client
from test_error_shape import _tool_error
from test_events import collect


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import paths
    import server

    importlib.reload(paths)
    importlib.reload(server)
    return app_client(server.app)


async def test_an_embedding_model_fastembed_cannot_load_is_refused_alike(
    client: TestClient,
) -> None:
    """An id without "org/" is ignored on read, so storing one would
    report a change that never takes effect."""
    rest = client.put("/settings", json={"rag": {"embed_model": "bge-m3"}})
    async with mcp_client() as session:
        result, _ = await call_tool(session, "update_settings", embed_model="bge-m3")

    assert rest.status_code == 400
    assert rest.json()["code"] == "validation_failed"
    assert rest.json()["details"]["field"] == "rag.embed_model"
    assert _tool_error(result) == (rest.json()["code"], rest.json()["details"])
    assert client.get("/settings").json()["rag"]["embed_model"] != "bge-m3"


@pytest.mark.parametrize(
    ("rest_body", "tool_args", "read", "expected"),
    [
        (
            {"labels": {"threshold_chars": 0}},
            {"ooc_threshold_chars": 0},
            ("labels", "threshold_chars"),
            1,
        ),
        ({"rag": {"top_k": 9999}}, {"top_k": 9999}, ("rag", "top_k"), 50),
        ({"rag": {"neighbors": -3}}, {"neighbors": -3}, ("rag", "neighbors"), 0),
    ],
)
async def test_an_out_of_range_number_is_clamped_alike(
    client: TestClient, rest_body, tool_args, read, expected
) -> None:
    section, name = read
    rest = client.put("/settings", json=rest_body).json()[section][name]
    # Away from the clamped value again, so the tool's change shows.
    client.put(
        "/settings",
        json={"labels": {"threshold_chars": 50}, "rag": {"top_k": 3, "neighbors": 2}},
    )
    async with mcp_client() as session:
        _, body = await call_tool(session, "update_settings", **tool_args)

    assert rest == expected
    assert list(body["changed"].values()) == [expected]
    assert client.get("/settings").json()[section][name] == expected


async def test_an_empty_model_name_resets_it_alike(client: TestClient) -> None:
    """The tool used to store the empty name; the window's route cleared it."""
    import rag

    client.put("/settings", json={"rag": {"rerank_model": "disabled"}})
    async with mcp_client() as session:
        await call_tool(session, "update_settings", rerank_model="")
    after_tool = client.get("/settings").json()["rag"]["rerank_model"]
    client.put("/settings", json={"rag": {"rerank_model": "disabled"}})
    after_rest = client.put("/settings", json={"rag": {"rerank_model": ""}}).json()
    after_rest = after_rest["rag"]["rerank_model"]

    assert after_tool == after_rest == rag.DEFAULT_RERANK_MODEL


def test_a_refused_field_changes_nothing_else(client: TestClient) -> None:
    before = client.get("/settings").json()
    res = client.put(
        "/settings", json={"rag": {"top_k": 7, "embed_model": "bge-m3"}}
    )

    assert res.status_code == 400
    assert client.get("/settings").json() == before


def test_null_clears_the_fchat_folder(client: TestClient, tmp_path: Path) -> None:
    """The window sends null when the folder field is emptied."""
    folder = tmp_path / "logs"
    folder.mkdir()
    client.put("/settings", json={"fchat_data_dir": str(folder)})
    res = client.put("/settings", json={"fchat_data_dir": None})

    assert res.json()["fchat_data_dir"] is None


async def test_a_model_changing_settings_tells_the_window(client: TestClient) -> None:
    from services import events

    events.bind_loop(asyncio.get_running_loop())

    async def change() -> None:
        await asyncio.sleep(0.05)
        async with mcp_client() as session:
            await call_tool(session, "update_settings", top_k=9999, ooc_threshold_chars=120)

    collector = asyncio.create_task(collect())
    await change()
    received = [e for e in await collector if e["event"] == "settings-changed"]

    assert len(received) == 1, received
    assert received[0]["origin"] == "mcp:update_settings"
    assert received[0]["changed"] == {"labels.threshold_chars": 120, "rag.top_k": 50}


async def test_the_window_changing_settings_is_announced_as_its_own(
    client: TestClient,
) -> None:
    from services import events

    events.bind_loop(asyncio.get_running_loop())

    async def change() -> None:
        await asyncio.sleep(0.05)
        client.put("/settings", json={"rag": {"hybrid_enabled": True}})
        client.put("/settings", json={})

    collector = asyncio.create_task(collect())
    await change()
    received = [e for e in await collector if e["event"] == "settings-changed"]

    assert [(e["origin"], e["changed"]) for e in received] == [
        ("ui", {"rag.hybrid_enabled": True})
    ]


def test_neither_adapter_checks_or_stores_a_value_itself() -> None:
    """The route and the tool parse, call the service and shape the
    answer. A clamp, a refusal or a write of their own is how the two
    drifted apart before."""
    import ast
    import inspect

    import routers.settings as route
    from workbench_mcp import tools_ops

    adapters = {
        "PUT /settings": ast.parse(inspect.getsource(route)),
        "update_settings": ast.parse(inspect.getsource(tools_ops.update_settings)),
    }
    for adapter, tree in adapters.items():
        calls = {
            node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
        }
        held = calls & {"max", "min", "set_value", "clear", "write_many", "ValidationFailed"}
        assert not held, (adapter, held)
