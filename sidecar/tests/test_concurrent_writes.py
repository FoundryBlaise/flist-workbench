"""Two writers on one character at once, from outside the sidecar.

The window saves the Workbench over REST; a model edits it over MCP.
Both can be at work on the same character at the same moment, each on
its own thread. Every write is checked against the etag its writer
read, under one lock per character, so of two writes that read the same
Workbench exactly one lands and the other is refused; neither is ever
lost without its writer being told.

These tests run the writers side by side and judge only what is on
disk afterwards and what each writer was told, never the order things
happened in. `sys.setswitchinterval` makes the threads take turns often,
so the writes really do interleave.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from mcp_helpers import call_tool, mcp_client
from sidecar_client import app_client
from test_mcp_reads import MAPPING

NAME = "Lady Amber Blaise"
URL = "/flist/character/42/workbench/payload"
ROUNDS = 40


@pytest.fixture
def sidecar(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")

    import archive_live
    import archive_registry
    import paths

    importlib.reload(paths)
    importlib.reload(archive_registry)

    cache = archive_registry.cache_root() / "mapping-list.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(MAPPING), encoding="utf-8")

    archive_registry.register_character("42", NAME)
    archive_live.write_live(
        "42",
        {
            "character": {"id": 42, "name": NAME, "description": "start"},
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1700000000,
        },
    )

    import server
    from services import mapping as mapping_service

    mapping_service.invalidate()
    importlib.reload(server)
    yield server
    mapping_service.invalidate()


@contextmanager
def threads_taking_turns_often():
    previous = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        yield
    finally:
        sys.setswitchinterval(previous)


def _tokens(description: str) -> list[str]:
    return [line for line in description.split("\n") if line and line != "start"]


def test_a_window_save_and_a_model_edit_never_overwrite_each_other_silently(
    sidecar,
) -> None:
    """Both append their own line to the description. Every line a
    writer was told it saved is there once at the end, and no line whose
    save was refused is."""
    # Outside a `with` block every request runs on its own event loop
    # thread, as threadpool work would.
    api = app_client(sidecar.app)
    assert api.get(URL).status_code == 200  # makes the Workbench from Live

    window_saved: list[str] = []
    window_refused: list[str] = []
    model_saved: list[str] = []
    model_refused: list[str] = []
    #: (etag, description) for every read and save either writer saw.
    seen: list[tuple[str, str]] = []

    def window() -> None:
        for i in range(ROUNDS):
            got = api.get(URL)
            assert got.status_code == 200, got.text
            read = got.json()
            payload = read["payload"]
            seen.append((read["etag"], payload["character"]["description"]))
            line = f"window {i}"
            payload["character"]["description"] += f"\n{line}"
            if "character.description" not in payload["_overlay"]:
                payload["_overlay"].append("character.description")
            res = api.put(URL, json=payload, headers={"If-Match": read["etag"]})
            if res.status_code == 200:
                window_saved.append(line)
                seen.append((res.json()["etag"], payload["character"]["description"]))
            else:
                assert res.status_code == 409, res.text
                assert res.json()["code"] == "etag_mismatch"
                window_refused.append(line)

    def model() -> None:
        async def run() -> None:
            async with mcp_client("character") as session:
                for j in range(ROUNDS):
                    line = f"model {j}"
                    result, _ = await call_tool(
                        session, "append_description", character=NAME, text=line
                    )
                    (model_refused if result.isError else model_saved).append(line)
                    _, raw = await call_tool(
                        session, "get_working_set_payload", character=NAME
                    )
                    seen.append(
                        (raw["etag"], raw["payload"]["character"]["description"])
                    )

        asyncio.run(run())

    with threads_taking_turns_often(), ThreadPoolExecutor(2) as pool:
        for future in [pool.submit(window), pool.submit(model)]:
            future.result()

    final = api.get(URL).json()["payload"]["character"]["description"]
    lines = _tokens(final)
    assert sorted(lines) == sorted(window_saved + model_saved)
    assert len(lines) == len(set(lines))
    assert not set(lines) & set(window_refused + model_refused)

    # A payload and its etag come from one read: an etag always names
    # the same contents, whoever read it.
    by_etag: dict[str, set[str]] = {}
    for etag, description in seen:
        by_etag.setdefault(etag, set()).add(description)
    assert {e: d for e, d in by_etag.items() if len(d) > 1} == {}


def test_making_the_workbench_from_live_never_overwrites_a_save(sidecar) -> None:
    """The first look at a character makes its Workbench from Live. A
    second look arriving at the same moment must not make it again over
    a save that landed in between."""
    import archive_live
    import archive_registry

    ids = [str(100 + n) for n in range(12)]
    for cid in ids:
        archive_registry.register_character(cid, f"Char {cid}")
        archive_live.write_live(
            cid,
            {
                "character": {"id": int(cid), "name": f"Char {cid}", "description": "live"},
                "images": [],
                "fetched_at": 1700000000,
            },
        )
    api = app_client(sidecar.app)
    saved: dict[str, str] = {}

    def window(cid: str) -> None:
        url = f"/flist/character/{cid}/workbench/payload"
        read = api.get(url).json()
        payload = read["payload"]
        payload["character"]["description"] = f"edited {cid}"
        payload["_overlay"] = ["character.description"]
        res = api.put(url, json=payload, headers={"If-Match": read["etag"]})
        if res.status_code == 200:
            saved[cid] = payload["character"]["description"]
        else:
            assert res.json()["code"] == "etag_mismatch", res.text

    def first_look(cid: str) -> None:
        assert api.get(f"/flist/character/{cid}/workbench").status_code == 200

    with threads_taking_turns_often(), ThreadPoolExecutor(8) as pool:
        futures = []
        for cid in ids:
            futures += [pool.submit(first_look, cid), pool.submit(window, cid)]
            futures += [pool.submit(first_look, cid) for _ in range(2)]
        for future in futures:
            future.result()

    assert saved, "no save went through"
    for cid, description in saved.items():
        payload = api.get(f"/flist/character/{cid}/workbench/payload").json()["payload"]
        assert payload["character"]["description"] == description, cid
