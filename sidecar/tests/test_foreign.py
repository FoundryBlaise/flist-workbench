"""The read-only foreign-profile viewer: cache, sources, budget, routes.

No live HTTP — `flist_api.fetch_character_data` and
`flist_api.fetch_social_lists` are stubbed. What these cover is the
behaviour the feature was asked for: a 24-hour TTL, a cache root that
nothing in the character archive can reach, and an MCP share of the
hourly F-list budget that runs out before the user's does.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sidecar_client import BASE_URL, SECRET_HEADER, TEST_LAUNCH_SECRET, app_client


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    return tmp_path


@pytest.fixture
def client(data_dir: Path) -> TestClient:
    from server import app

    return app_client(app)


def _profile(name: str = "Anexample Person", **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": name,
        "id": 4242,
        "description": "[b]Hello[/b]",
        "infotags": {"1": "Human"},
        "kinks": {"12": "fave"},
        "custom_kinks": {},
        "images": [{"image_id": "900", "extension": "png"}],
        "views": 7,
    }
    payload.update(extra)
    return payload


def _stub_fetch(monkeypatch: pytest.MonkeyPatch, payload: dict[str, Any]) -> list[str]:
    """Patch character-data.php. Returns the list of names asked for so
    a test can assert a cache hit made no call."""
    import flist_api

    calls: list[str] = []

    async def _stub(name: str, *, client=None):
        calls.append(name)
        return payload

    monkeypatch.setattr(flist_api, "fetch_character_data", _stub)
    return calls


# ---- cache store ------------------------------------------------------


def test_cache_lives_outside_the_character_archive(data_dir: Path) -> None:
    """The whole no-copying guarantee rests on this: nothing the
    archive can address may point into the foreign cache."""
    import archive_registry
    import foreign_cache

    foreign_cache.write_profile("Anexample Person", _profile())

    assert foreign_cache.root() == data_dir / "foreign"
    assert archive_registry.root() == data_dir / "characters"
    archive_files = list(archive_registry.root().rglob("*"))
    assert archive_files == [], archive_files


def test_slugs_are_case_insensitive(data_dir: Path) -> None:
    import foreign_cache

    foreign_cache.write_profile("Anexample Person", _profile())
    # A lowercased spelling, as an F-Chat log directory would give it.
    assert foreign_cache.read_profile("anexample person") is not None
    assert foreign_cache.slug_for("ANEXAMPLE PERSON") == foreign_cache.slug_for(
        "Anexample Person"
    )


def test_unsafe_names_hash_into_an_f_prefixed_folder(data_dir: Path) -> None:
    import foreign_cache

    slug = foreign_cache.slug_for("Café / Noir")
    assert slug.startswith("f_")
    assert "/" not in slug


@pytest.mark.parametrize(
    "name",
    ["..", ".", "...", "..hidden", "trailing.", "CON", "nul", "Com1.txt", "LPT9", "../escape", "..\\escape"],
)
def test_dots_and_reserved_names_stay_inside_the_cache_folder(
    data_dir: Path, name: str
) -> None:
    import foreign_cache

    folder = foreign_cache.profile_dir(name)
    foreign_cache.write_profile(name, _profile(name))

    assert folder.resolve().parent == foreign_cache.root().resolve()
    assert foreign_cache.read_profile(name) is not None
    assert foreign_cache.delete_profile(name) is True
    assert foreign_cache.root().is_dir()


def test_read_profile_rejects_a_folder_holding_another_character(
    data_dir: Path,
) -> None:
    import foreign_cache

    foreign_cache.write_profile("Anexample Person", _profile())
    path = foreign_cache.profile_dir("Anexample Person") / "profile.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    stored["name"] = "Somebody Else"
    path.write_text(json.dumps(stored), encoding="utf-8")

    assert foreign_cache.read_profile("Anexample Person") is None


def test_freshness_follows_the_fetched_at_stamp(data_dir: Path) -> None:
    import foreign_cache

    stored = foreign_cache.write_profile("Anexample Person", _profile())
    assert foreign_cache.is_fresh(stored)

    stored["fetched_at"] = int(time.time()) - (25 * 3600)
    assert not foreign_cache.is_fresh(stored)
    # A payload with no stamp at all is stale, not infinitely fresh.
    assert not foreign_cache.is_fresh({"name": "x"})


# ---- the service ------------------------------------------------------


@pytest.mark.anyio
async def test_a_fresh_cache_entry_costs_no_api_call(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import foreign as foreign_service

    calls = _stub_fetch(monkeypatch, _profile())

    first = await foreign_service.get_profile("Anexample Person")
    second = await foreign_service.get_profile("Anexample Person")

    assert first["from_cache"] is False
    assert second["from_cache"] is True
    assert calls == ["Anexample Person"]


@pytest.mark.anyio
async def test_refresh_bypasses_a_fresh_cache_entry(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import foreign as foreign_service

    calls = _stub_fetch(monkeypatch, _profile())
    await foreign_service.get_profile("Anexample Person")
    again = await foreign_service.get_profile("Anexample Person", refresh=True)

    assert again["from_cache"] is False
    assert len(calls) == 2


@pytest.mark.anyio
async def test_an_expired_entry_is_refetched(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import foreign_cache
    from services import foreign as foreign_service

    calls = _stub_fetch(monkeypatch, _profile())
    await foreign_service.get_profile("Anexample Person")

    path = foreign_cache.profile_dir("Anexample Person") / "profile.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    stored["fetched_at"] = int(time.time()) - (25 * 3600)
    path.write_text(json.dumps(stored), encoding="utf-8")

    result = await foreign_service.get_profile("Anexample Person")
    assert result["from_cache"] is False
    assert len(calls) == 2


@pytest.mark.anyio
async def test_the_cache_is_keyed_on_f_lists_canonical_spelling(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A name picked out of a log arrives lowercased. The entry it
    creates has to be the same one a bookmark's spelling finds."""
    import foreign_cache
    from services import foreign as foreign_service

    _stub_fetch(monkeypatch, _profile("Anexample Person"))
    result = await foreign_service.get_profile("anexample person")

    assert result["name"] == "Anexample Person"
    assert foreign_cache.read_profile("Anexample Person") is not None


@pytest.mark.anyio
async def test_a_stale_copy_survives_a_failed_refresh(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import flist_api
    from services import foreign as foreign_service

    _stub_fetch(monkeypatch, _profile())
    await foreign_service.get_profile("Anexample Person")

    async def _boom(name: str, *, client=None):
        raise flist_api.FlistApiError("f-list is having a moment")

    monkeypatch.setattr(flist_api, "fetch_character_data", _boom)
    result = await foreign_service.get_profile("Anexample Person", refresh=True)

    assert result["stale"] is True
    assert result["profile"]["name"] == "Anexample Person"
    assert "moment" in result["refresh_error"]


@pytest.mark.anyio
async def test_an_unknown_name_with_no_cached_copy_is_not_found(flist) -> None:
    from services import foreign as foreign_service

    _flist_answers(flist, json={"error": "No such character."})
    with pytest.raises(foreign_service.ForeignError) as excinfo:
        await foreign_service.get_profile("Nobody At All")
    assert excinfo.value.code == "not_found"


# ---- candidate sources ------------------------------------------------


@pytest.mark.anyio
async def test_free_text_is_taken_as_an_exact_name(data_dir: Path) -> None:
    from services import foreign as foreign_service

    result = await foreign_service.search("  Anexample Person ", "name")
    assert result["results"] == ["Anexample Person"]
    assert result["exact"] is True


@pytest.mark.anyio
async def test_bookmarks_and_friends_are_filtered_and_memoised(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import flist_api
    from services import foreign as foreign_service

    foreign_service.reset_social_cache()
    calls: list[int] = []

    async def _stub(*, client=None):
        calls.append(1)
        return {
            "bookmarks": ["Alpha One", "Beta Two"],
            "friends": ["Gamma Three"],
        }

    monkeypatch.setattr(flist_api, "fetch_social_lists", _stub)

    hits = await foreign_service.search("alpha", "bookmarks")
    assert hits["results"] == ["Alpha One"]

    again = await foreign_service.search("", "friends")
    assert again["results"] == ["Gamma Three"]
    # One call served both source tabs.
    assert len(calls) == 1
    foreign_service.reset_social_cache()


@pytest.mark.anyio
async def test_an_unknown_source_is_rejected(data_dir: Path) -> None:
    from services import foreign as foreign_service

    with pytest.raises(foreign_service.ForeignError) as excinfo:
        await foreign_service.search("x", "telepathy")
    assert excinfo.value.code == "validation_failed"


def _fchat_tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **chars: tuple) -> Path:
    fchat = tmp_path / "fchat"
    for character, partners in chars.items():
        logs = fchat / character / "logs"
        logs.mkdir(parents=True)
        for partner in partners:
            (logs / partner).write_bytes(b"x")
    monkeypatch.setenv("FCHAT_DATA_DIR", str(fchat))
    from services import foreign as foreign_service

    foreign_service.reset_log_partner_cache()
    return fchat


def test_log_partners_skips_channels_and_index_files(
    data_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import foreign as foreign_service

    _fchat_tree(
        tmp_path,
        monkeypatch,
        MyChar=(
            "anexample person",
            "anexample person.idx",
            "#somechannel",
            "#adh-0a1b2c3d",
            "_",
        ),
    )
    assert foreign_service.log_partners() == ["anexample person"]
    foreign_service.reset_log_partner_cache()


def test_log_partners_merges_across_characters(
    data_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import foreign as foreign_service

    _fchat_tree(
        tmp_path,
        monkeypatch,
        CharOne=("shared partner", "only one"),
        CharTwo=("shared partner", "only two"),
    )
    assert foreign_service.log_partners() == [
        "only one",
        "only two",
        "shared partner",
    ]
    foreign_service.reset_log_partner_cache()


def test_log_partners_is_cached(
    data_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The sweep walks every character directory on disk. Running it
    per keystroke cost eight seconds on a real corpus."""
    from services import foreign as foreign_service

    fchat = _fchat_tree(tmp_path, monkeypatch, MyChar=("first partner",))
    assert foreign_service.log_partners() == ["first partner"]

    # A new conversation on disk is not picked up until the TTL lapses
    # or something forces a rescan — that is the trade the cache makes.
    (fchat / "MyChar" / "logs" / "second partner").write_bytes(b"x")
    assert foreign_service.log_partners() == ["first partner"]
    assert foreign_service.log_partners(force=True) == [
        "first partner",
        "second partner",
    ]
    foreign_service.reset_log_partner_cache()


def test_log_partners_without_a_log_directory_says_so(
    data_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import foreign as foreign_service

    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "nothing-here"))
    foreign_service.reset_log_partner_cache()
    with pytest.raises(foreign_service.ForeignError) as excinfo:
        foreign_service.log_partners()
    assert excinfo.value.code == "log_dir_unavailable"
    foreign_service.reset_log_partner_cache()


# ---- the MCP budget ---------------------------------------------------


@pytest.fixture
def mcp_budget(data_dir: Path):
    """A model's full hourly share, as a freshly started sidecar has.
    The share outlives a test otherwise: it is the sidecar's, not one
    connection's."""
    import flist_api

    flist_api.reset_mcp_budget()
    yield
    flist_api.reset_mcp_budget()


def _stub_any_profile(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """character-data.php answering for whichever name is asked."""
    import flist_api

    calls: list[str] = []

    async def _stub(name: str, *, client=None):
        calls.append(name)
        return _profile(name)

    monkeypatch.setattr(flist_api, "fetch_character_data", _stub)
    return calls


async def _model_opens(session, name: str) -> tuple[Any, Any]:
    from mcp_helpers import call_tool

    return await call_tool(session, "get_foreign_profile", character=name)


def _window():
    import httpx

    from server import app

    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url=BASE_URL,
        headers={SECRET_HEADER: TEST_LAUNCH_SECRET},
    )


async def test_a_model_may_spend_a_quarter_of_the_hourly_cap_and_the_window_keeps_working(
    mcp_budget: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The point of the separate share: a model walking someone's
    friend list runs out long before the user can no longer pull."""
    import flist_api
    from mcp_helpers import mcp_client, tool_error_text

    _stub_any_profile(monkeypatch)
    share = flist_api.HARD_PER_HOUR // 4

    async with mcp_client() as session:
        opened = []
        for i in range(share):
            result, body = await _model_opens(session, f"Visitor {i}")
            assert not result.isError, body
            opened.append(body["budget_remaining"])
        refused, _ = await _model_opens(session, "One Too Many")

    assert opened[0] == share - 1
    assert opened[-1] == 0
    assert "rate_limited:" in tool_error_text(refused)
    async with _window() as window:
        res = await window.get("/foreign/character/One Too Many")
    assert res.status_code == 200, res.text
    assert res.json()["from_cache"] is False


async def test_a_cache_hit_costs_a_model_nothing(
    mcp_budget: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from mcp_helpers import mcp_client

    calls = _stub_any_profile(monkeypatch)

    async with mcp_client() as session:
        _, first = await _model_opens(session, "Anexample Person")
        _, again = await _model_opens(session, "Anexample Person")

    assert again["from_cache"] is True
    assert again["budget_remaining"] == first["budget_remaining"]
    assert calls == ["Anexample Person"]


async def test_a_lookup_that_never_reached_f_list_costs_a_model_nothing(
    mcp_budget: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    import flist_api
    from mcp_helpers import mcp_client, tool_error_text

    async def _signed_out(name: str, *, client=None):
        raise flist_api.TicketRequired("sign in first")

    async with mcp_client() as session:
        monkeypatch.setattr(flist_api, "fetch_character_data", _signed_out)
        refused, _ = await _model_opens(session, "Anexample Person")
        _stub_any_profile(monkeypatch)
        _, body = await _model_opens(session, "Anexample Person")

    assert "not_signed_in:" in tool_error_text(refused)
    assert body["budget_remaining"] == flist_api.HARD_PER_HOUR // 4 - 1


async def test_the_activity_log_records_which_profiles_a_model_fetched(
    mcp_budget: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The docs promise it: whichever tool read the profile, the
    activity log names it, and still does after the sidecar restarts."""
    import flist_activity
    from mcp_helpers import call_tool, mcp_client

    _stub_any_profile(monkeypatch)
    flist_activity.reset()
    flist_activity.enable_disk_writes()

    async with mcp_client() as session:
        await _model_opens(session, "Anexample Person")
        await call_tool(session, "get_foreign_kinks", character="Another Example")

    flist_activity.reset()
    flist_activity.hydrate_from_disk()
    fetched = [
        (e["kind"], e.get("character"))
        for e in flist_activity.snapshot()["events"]
        if e["kind"].startswith("mcp:get_foreign")
    ]
    assert fetched == [
        ("mcp:get_foreign_profile", "Anexample Person"),
        ("mcp:get_foreign_kinks", "Another Example"),
    ]


# ---- routes -----------------------------------------------------------


def test_route_serves_a_profile_and_then_a_cache_hit(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _stub_fetch(monkeypatch, _profile())

    first = client.get("/foreign/character/Anexample Person")
    assert first.status_code == 200
    assert first.json()["profile"]["description"] == "[b]Hello[/b]"
    assert first.json()["from_cache"] is False

    second = client.get("/foreign/character/Anexample Person")
    assert second.json()["from_cache"] is True
    assert len(calls) == 1


def test_route_maps_a_missing_session_to_401(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import flist_api

    async def _boom(name: str, *, client=None):
        raise flist_api.TicketRequired("sign in first")

    monkeypatch.setattr(flist_api, "fetch_character_data", _boom)
    res = client.get("/foreign/character/Anexample Person")
    assert res.status_code == 401
    assert res.json()["code"] == "not_signed_in"


def test_route_rejects_an_unknown_source(client: TestClient) -> None:
    res = client.get("/foreign/search", params={"source": "telepathy"})
    assert res.status_code == 400


def test_image_route_refuses_an_id_the_gallery_does_not_list(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without this the route would proxy any id off the F-list CDN."""
    _stub_fetch(monkeypatch, _profile())
    client.get("/foreign/character/Anexample Person")

    res = client.get("/foreign/character/Anexample Person/image/999999")
    assert res.status_code == 404
    assert "gallery" in res.json()["message"]


def test_image_route_serves_a_cached_file_without_downloading(
    client: TestClient, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import flist_api
    import foreign_cache

    _stub_fetch(monkeypatch, _profile())
    client.get("/foreign/character/Anexample Person")
    foreign_cache.image_path("Anexample Person", "900", "png").write_bytes(b"PNGDATA")

    async def _never(*args: Any, **kwargs: Any):
        raise AssertionError("cached image should not be downloaded again")

    monkeypatch.setattr(flist_api, "download_to", _never)
    res = client.get("/foreign/character/Anexample Person/image/900")
    assert res.status_code == 200
    assert res.content == b"PNGDATA"


def test_image_route_downloads_on_first_request_and_serves_the_bytes(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, httpx_mock
) -> None:
    import flist_api

    _stub_fetch(monkeypatch, _profile())
    client.get("/foreign/character/Anexample Person")
    # One response, used once: a second download would find nothing.
    httpx_mock.add_response(
        url=f"{flist_api.STATIC_BASE}/images/charimage/900.png", content=b"PNGDATA"
    )

    first = client.get("/foreign/character/Anexample Person/image/900")
    again = client.get("/foreign/character/Anexample Person/image/900")

    assert (first.status_code, first.content) == (200, b"PNGDATA")
    assert (again.status_code, again.content) == (200, b"PNGDATA")


@pytest.mark.anyio
async def test_a_gallery_loads_several_images_at_once_but_never_more_than_the_cap(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch, httpx_mock
) -> None:
    """Matches the prior art. F-Chat 3.0 renders a gallery as plain
    <img> tags with no pacing, and Horizon caps concurrency on the
    JSON API (`throat(2)`) while leaving CDN images alone. Workbench
    needs a cap only because its images go through the sidecar to be
    cached, which funnels the browser's parallelism into one queue.
    A gallery paced like the Pull's image sweep (2/s) would load one
    image at a time here."""
    import re

    import httpx

    import flist_api
    from server import app

    cap = flist_api.FOREIGN_IMAGE_CONCURRENCY
    ids = [str(900 + i) for i in range(cap + 4)]
    _stub_fetch(
        monkeypatch,
        _profile(images=[{"image_id": i, "extension": "png"} for i in ids]),
    )
    in_flight = 0
    peak = 0

    async def cdn(request: httpx.Request) -> httpx.Response:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.2)
        in_flight -= 1
        return httpx.Response(200, content=request.url.path.encode())

    httpx_mock.add_callback(
        cdn, url=re.compile(r".*/images/charimage/.*"), is_reusable=True
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url=BASE_URL,
        headers={SECRET_HEADER: TEST_LAUNCH_SECRET},
    ) as c:
        assert (await c.get("/foreign/character/Anexample Person")).status_code == 200
        results = await asyncio.gather(
            *(c.get(f"/foreign/character/Anexample Person/image/{i}") for i in ids)
        )

    assert [r.status_code for r in results] == [200] * len(ids)
    assert [r.content for r in results] == [
        f"/images/charimage/{i}.png".encode() for i in ids
    ]
    assert 1 < peak <= cap


def test_image_route_404s_when_the_profile_was_never_opened(
    client: TestClient,
) -> None:
    res = client.get("/foreign/character/Never Opened/image/900")
    assert res.status_code == 404


# ---- what F-list answered ---------------------------------------------
#
# F-list at the HTTP seam, with a session open. character-data.php
# answers a profile it will not show (deleted, private, or the owner
# blocked the account) with a 200 carrying an `error` text; the client
# cannot tell those three apart, and none of them may keep a copy.


@pytest.fixture
def flist(data_dir: Path, monkeypatch: pytest.MonkeyPatch, httpx_mock):
    """A signed-in F-list with the per-second pacing taken out."""
    import flist_api

    fast = flist_api.RateLimiter(per_second=1000.0, per_hour_cap=1_000_000)
    monkeypatch.setattr(flist_api, "_LIMITER", fast)
    flist_api.ticket_store().set(
        flist_api.Ticket(
            account="test-account",
            value="test-ticket",
            password="test-password",
            acquired_at=time.monotonic(),
        )
    )
    flist_api.reset_mcp_budget()
    yield httpx_mock
    flist_api.reset_mcp_budget()
    flist_api.ticket_store().clear()


def _flist_answers(httpx_mock, **kwargs: Any) -> None:
    import flist_api

    httpx_mock.add_response(url=flist_api.CHARACTER_DATA_URL, method="POST", **kwargs)


def _flist_unreachable(httpx_mock, exc: Exception) -> None:
    import flist_api

    httpx_mock.add_exception(exc, url=flist_api.CHARACTER_DATA_URL, method="POST")


def _open_with_files(client: TestClient, httpx_mock) -> Path:
    """Open the profile in the window, with its avatar and one gallery
    image, as a user looking at it would. Returns its cache folder."""
    import flist_api
    import foreign_cache

    _flist_answers(httpx_mock, json={**_profile(), "error": ""})
    httpx_mock.add_response(url=flist_api.avatar_url("Anexample Person"), content=b"AVATAR")
    httpx_mock.add_response(
        url=f"{flist_api.STATIC_BASE}/images/charimage/900.png", content=b"PNGDATA"
    )
    assert client.get("/foreign/character/Anexample Person").status_code == 200
    assert client.get("/foreign/character/Anexample Person/avatar").status_code == 200
    assert client.get("/foreign/character/Anexample Person/image/900").status_code == 200
    folder = foreign_cache.profile_dir("Anexample Person")
    assert sorted(p.name for p in folder.rglob("*") if p.is_file()) == [
        "900.png",
        "avatar.png",
        "profile.json",
    ]
    return folder


def test_a_profile_f_list_will_not_show_is_dropped_with_its_files(
    client: TestClient, flist
) -> None:
    folder = _open_with_files(client, flist)
    _flist_answers(flist, json={"error": "This profile is not available."})

    res = client.get("/foreign/character/Anexample Person", params={"refresh": "true"})

    assert res.status_code == 404, res.text
    assert res.json()["code"] == "not_found"
    assert not folder.exists()
    again = client.get("/foreign/character/Anexample Person/image/900")
    assert again.json()["code"] == "profile_not_cached"


async def test_a_model_asking_for_a_profile_f_list_will_not_show_drops_it_too(
    flist, monkeypatch: pytest.MonkeyPatch
) -> None:
    import foreign_cache
    from mcp_helpers import call_tool, mcp_client, tool_error_text

    _flist_answers(flist, json={**_profile(), "error": ""})
    _flist_answers(flist, json={"error": "This profile is not available."})
    async with mcp_client() as session:
        opened, _ = await _model_opens(session, "Anexample Person")
        refused, _ = await call_tool(
            session, "get_foreign_profile", character="Anexample Person", refresh=True
        )

    assert not opened.isError
    assert "not_found:" in tool_error_text(refused)
    assert foreign_cache.read_profile("Anexample Person") is None
    assert not foreign_cache.profile_dir("Anexample Person").exists()


@pytest.mark.parametrize("failure", ["connect", "timeout"])
def test_offline_serves_the_cached_copy_marked_stale(
    client: TestClient, flist, failure: str
) -> None:
    import httpx

    _flist_answers(flist, json={**_profile(), "error": ""})
    assert client.get("/foreign/character/Anexample Person").status_code == 200
    exc = httpx.ConnectError("offline") if failure == "connect" else httpx.ReadTimeout("slow")
    _flist_unreachable(flist, exc)

    res = client.get("/foreign/character/Anexample Person", params={"refresh": "true"})

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["stale"] is True
    assert body["profile"]["description"] == "[b]Hello[/b]"


@pytest.mark.parametrize("failure", ["connect", "timeout"])
def test_offline_without_a_cached_copy_says_f_list_could_not_be_reached(
    client: TestClient, flist, failure: str
) -> None:
    import httpx

    exc = httpx.ConnectError("offline") if failure == "connect" else httpx.ReadTimeout("slow")
    _flist_unreachable(flist, exc)

    res = client.get("/foreign/character/Anexample Person")

    assert res.status_code == 503, res.text
    assert res.json()["code"] == "flist_unreachable"


@pytest.mark.parametrize("status", [500, 503])
def test_an_f_list_server_error_is_reported_as_one(
    client: TestClient, flist, status: int
) -> None:
    _flist_answers(flist, status_code=status, text="<html>maintenance</html>")

    res = client.get("/foreign/character/Anexample Person")

    assert res.status_code == 502, res.text
    assert res.json()["code"] == "flist_server_error"


def test_an_f_list_server_error_serves_the_cached_copy_marked_stale(
    client: TestClient, flist
) -> None:
    _flist_answers(flist, json={**_profile(), "error": ""})
    assert client.get("/foreign/character/Anexample Person").status_code == 200
    _flist_answers(flist, status_code=502)

    res = client.get("/foreign/character/Anexample Person", params={"refresh": "true"})

    assert res.status_code == 200, res.text
    assert res.json()["stale"] is True


@pytest.mark.parametrize(
    "answer",
    [{"status_code": 403, "text": "Forbidden"}, {"status_code": 200, "text": "<html>"}],
    ids=["http-403", "not-json"],
)
def test_an_answer_that_is_not_f_lists_word_on_the_profile_is_never_not_found(
    client: TestClient, flist, answer: dict[str, Any]
) -> None:
    _flist_answers(flist, **answer)

    res = client.get("/foreign/character/Anexample Person")

    assert res.status_code == 502, res.text
    assert res.json()["code"] != "not_found"


def _age_past_the_ttl(name: str) -> None:
    """Make the cached copy a day and more old, so the next look asks
    F-list again."""
    import foreign_cache

    path = foreign_cache.profile_dir(name) / "profile.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    stored["fetched_at"] = int(time.time()) - (25 * 3600)
    path.write_text(json.dumps(stored), encoding="utf-8")


def _tool_error_details(result: Any) -> dict[str, Any]:
    """The JSON details a `code: message {...}` tool error carries."""
    from mcp_helpers import tool_error_text

    text = tool_error_text(result)
    details, _ = json.JSONDecoder().raw_decode(text[text.index(" {") + 1 :])
    return details


@pytest.mark.parametrize(
    ("tool", "field"),
    [("get_foreign_profile", "custom_kink_count"), ("get_foreign_kinks", "kinks")],
)
async def test_a_spent_budget_is_rate_limited_and_still_hands_over_the_cached_copy(
    flist, tool: str, field: str
) -> None:
    import flist_api
    from mcp_helpers import call_tool, mcp_client, tool_error_text

    _flist_answers(flist, json={**_profile(), "error": ""})
    async with mcp_client() as session:
        opened, _ = await _model_opens(session, "Anexample Person")
        _age_past_the_ttl("Anexample Person")
        budget = flist_api.mcp_character_budget()
        while budget.remaining():
            budget.charge()
        refused, _ = await call_tool(session, tool, character="Anexample Person")

    assert not opened.isError
    assert "rate_limited:" in tool_error_text(refused)
    cached = _tool_error_details(refused)["cached"]
    assert cached["character"] == "Anexample Person"
    assert cached["stale"] is True
    assert field in cached


async def test_a_spent_budget_with_nothing_cached_is_plainly_rate_limited(flist) -> None:
    import flist_api
    from mcp_helpers import mcp_client, tool_error_text

    budget = flist_api.mcp_character_budget()
    while budget.remaining():
        budget.charge()
    async with mcp_client() as session:
        refused, _ = await _model_opens(session, "Anexample Person")

    text = tool_error_text(refused)
    assert "rate_limited:" in text
    assert "cached" not in text


# ---- the size cap -----------------------------------------------------
#
# The cache is a copy of other people's profiles, so it is bounded: the
# least recently viewed profile goes, with its images and avatar, when
# a new one no longer fits under the cap set in Settings.

MB = 1024 * 1024


def _set_cap_mb(client: TestClient, mb: int) -> None:
    res = client.put("/settings", json={"foreign": {"cache_cap_mb": mb}})
    assert res.status_code == 200, res.text


def _view_new(
    client: TestClient,
    httpx_mock,
    name: str,
    image_id: str,
    image_bytes: int,
    *,
    refresh: bool = False,
    avatar: bytes = b"AVATAR",
) -> None:
    """Open `name` in the window as F-list answers it: the profile, its
    avatar and its one gallery image of `image_bytes` bytes."""
    import flist_api

    _flist_answers(
        httpx_mock,
        json={**_profile(name, images=[{"image_id": image_id, "extension": "png"}]), "error": ""},
    )
    httpx_mock.add_response(url=flist_api.avatar_url(name), content=avatar)
    httpx_mock.add_response(
        url=f"{flist_api.STATIC_BASE}/images/charimage/{image_id}.png",
        content=b"x" * image_bytes,
    )
    params = {"refresh": "true"} if refresh else {}
    assert client.get(f"/foreign/character/{name}", params=params).status_code == 200
    assert client.get(f"/foreign/character/{name}/avatar").status_code == 200
    assert client.get(f"/foreign/character/{name}/image/{image_id}").status_code == 200


def _cached(name: str) -> bool:
    import foreign_cache

    return foreign_cache.profile_dir(name).exists()


def test_with_a_small_cap_a_new_profile_evicts_the_least_recently_viewed_with_its_files(
    client: TestClient, flist
) -> None:
    _set_cap_mb(client, 1)
    _view_new(client, flist, "First Visit", "901", 400_000)
    _view_new(client, flist, "Second Visit", "902", 400_000)

    _view_new(client, flist, "Third Visit", "903", 400_000)

    assert not _cached("First Visit")
    assert _cached("Second Visit") and _cached("Third Visit")
    gone = client.get("/foreign/character/First Visit/image/901")
    assert gone.json()["code"] == "profile_not_cached"


def test_viewing_a_cached_profile_again_keeps_it_through_the_next_eviction(
    client: TestClient, flist
) -> None:
    _set_cap_mb(client, 1)
    _view_new(client, flist, "First Visit", "901", 400_000)
    _view_new(client, flist, "Second Visit", "902", 400_000)
    again = client.get("/foreign/character/First Visit")
    assert again.json()["from_cache"] is True

    _view_new(client, flist, "Third Visit", "903", 400_000)

    assert _cached("First Visit") and _cached("Third Visit")
    assert not _cached("Second Visit")


def test_a_refresh_drops_images_that_left_the_gallery_and_replaces_the_avatar(
    client: TestClient, flist
) -> None:
    import foreign_cache

    _view_new(client, flist, "Anexample Person", "901", 1000)

    _view_new(client, flist, "Anexample Person", "902", 1000, refresh=True, avatar=b"NEW")

    images = foreign_cache.profile_dir("Anexample Person") / "images"
    assert sorted(p.name for p in images.iterdir()) == ["902.png"]
    avatar = client.get("/foreign/character/Anexample Person/avatar")
    assert avatar.content == b"NEW"


def test_the_cap_is_a_gigabyte_until_settings_change_it(client: TestClient) -> None:
    body = client.get("/settings").json()
    assert body["foreign"] == {"cache_cap_mb": 1024, "defaults": {"cache_cap_mb": 1024}}
    assert client.get("/foreign/cache").json()["cap_bytes"] == 1024 * MB

    res = client.put("/settings", json={"foreign": {"cache_cap_mb": 0}})

    assert res.json()["foreign"]["cache_cap_mb"] == 1
    assert client.get("/foreign/cache").json()["cap_bytes"] == MB


def test_the_cache_reports_what_it_holds_and_clears_on_request(
    client: TestClient, flist
) -> None:
    import foreign_cache

    _view_new(client, flist, "First Visit", "901", 300_000)
    _view_new(client, flist, "Second Visit", "902", 300_000)
    on_disk = sum(p.stat().st_size for p in foreign_cache.root().rglob("*") if p.is_file())

    usage = client.get("/foreign/cache").json()
    assert usage["profiles"] == 2
    assert 600_000 < usage["bytes"] <= on_disk

    cleared = client.delete("/foreign/cache").json()

    assert (cleared["removed"], cleared["bytes"], cleared["profiles"]) == (2, 0, 0)
    assert not _cached("First Visit") and not _cached("Second Visit")
    assert client.get("/foreign/cache").json()["bytes"] == 0


def test_a_cache_from_before_the_size_index_is_counted(client: TestClient) -> None:
    import foreign_cache

    foreign_cache.write_profile("Old Visit", _profile("Old Visit"))
    foreign_cache.image_path("Old Visit", "900", "png").write_bytes(b"x" * 5000)

    usage = client.get("/foreign/cache").json()

    assert usage["profiles"] == 1
    assert usage["bytes"] > 5000


def test_lowering_the_cap_evicts_at_once_but_keeps_the_last_viewed_profile(
    client: TestClient, flist
) -> None:
    _view_new(client, flist, "First Visit", "901", 400_000)
    _view_new(client, flist, "Second Visit", "902", 400_000)
    _view_new(client, flist, "Third Visit", "903", 400_000)

    _set_cap_mb(client, 1)

    assert not _cached("First Visit")
    assert _cached("Second Visit") and _cached("Third Visit")


def test_a_profile_larger_than_the_cap_still_opens(client: TestClient, flist) -> None:
    _set_cap_mb(client, 1)
    _view_new(client, flist, "First Visit", "901", 400_000)

    _view_new(client, flist, "Huge Gallery", "902", 2 * MB)

    assert _cached("Huge Gallery")
    assert not _cached("First Visit")


def test_signing_out_drops_the_memoised_social_lists(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import flist_api
    from services import foreign as foreign_service

    foreign_service.reset_social_cache()
    calls: list[int] = []

    async def _stub(*, client=None):
        calls.append(1)
        return {"bookmarks": ["Alpha One"], "friends": []}

    monkeypatch.setattr(flist_api, "fetch_social_lists", _stub)

    client.get("/foreign/search", params={"source": "bookmarks"})
    client.delete("/flist/session")
    client.get("/foreign/search", params={"source": "bookmarks"})

    assert len(calls) == 2
    foreign_service.reset_social_cache()
