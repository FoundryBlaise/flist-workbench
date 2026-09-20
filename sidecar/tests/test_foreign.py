"""The read-only foreign-profile viewer: cache, sources, budget, routes.

No live HTTP — `flist_api.fetch_character_data` and
`flist_api.fetch_social_lists` are stubbed. What these cover is the
behaviour the feature was asked for: a 24-hour TTL, a cache root that
nothing in `character_archive` can reach, and an MCP share of the
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


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    return tmp_path


@pytest.fixture
def client(data_dir: Path) -> TestClient:
    from server import app

    return TestClient(app)


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
    import character_archive
    import foreign_cache

    foreign_cache.write_profile("Anexample Person", _profile())

    assert foreign_cache.root() == data_dir / "foreign"
    assert character_archive.root() == data_dir / "characters"
    archive_files = list(character_archive.root().rglob("*"))
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
async def test_an_unknown_name_with_no_cached_copy_is_not_found(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import flist_api
    from services import foreign as foreign_service

    async def _boom(name: str, *, client=None):
        raise flist_api.FlistApiError("no such character")

    monkeypatch.setattr(flist_api, "fetch_character_data", _boom)
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
    assert excinfo.value.code == "no_logs"
    foreign_service.reset_log_partner_cache()


# ---- the MCP budget ---------------------------------------------------


def test_the_mcp_share_is_a_quarter_of_the_hourly_cap() -> None:
    import flist_api

    assert flist_api.MCP_PER_HOUR == flist_api.HARD_PER_HOUR // 4 == 50


def test_the_budget_runs_out_and_refunds_a_call_that_never_happened() -> None:
    import flist_api

    budget = flist_api.HourlyBudget(cap=2, label="test")
    budget.charge()
    budget.charge()
    assert budget.remaining() == 0
    with pytest.raises(flist_api.RateLimited):
        budget.charge()

    budget.refund()
    assert budget.remaining() == 1


@pytest.mark.anyio
async def test_a_spent_mcp_budget_leaves_the_window_working(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The point of the separate budget: MCP stops, the user does not."""
    import flist_api
    from services import foreign as foreign_service

    _stub_fetch(monkeypatch, _profile())
    spent = flist_api.HourlyBudget(cap=0, label="MCP")

    with pytest.raises(flist_api.RateLimited):
        await foreign_service.get_profile("Anexample Person", budget=spent)

    # No budget passed = the Workbench window. Still fine.
    result = await foreign_service.get_profile("Anexample Person")
    assert result["from_cache"] is False


@pytest.mark.anyio
async def test_a_cache_hit_does_not_charge_the_budget(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import flist_api
    from services import foreign as foreign_service

    _stub_fetch(monkeypatch, _profile())
    budget = flist_api.HourlyBudget(cap=5, label="MCP")

    await foreign_service.get_profile("Anexample Person", budget=budget)
    assert budget.remaining() == 4
    await foreign_service.get_profile("Anexample Person", budget=budget)
    assert budget.remaining() == 4


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
    assert res.json()["detail"]["code"] == "not_signed_in"


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
    assert "gallery" in res.json()["detail"]


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


@pytest.mark.anyio
async def test_gallery_images_are_capped_on_concurrency_not_paced() -> None:
    """Matches the prior art. F-Chat 3.0 renders a gallery as plain
    <img> tags with no pacing, and Horizon caps concurrency on the
    JSON API (`throat(2)`) while leaving CDN images alone. Workbench
    needs a cap only because its images go through the sidecar to be
    cached, which funnels the browser's parallelism into one queue."""
    import flist_api

    gate = flist_api.foreign_image_gate()
    assert isinstance(gate, asyncio.Semaphore)
    assert flist_api.FOREIGN_IMAGE_CONCURRENCY > 1
    # Not a per-second lane: the sweep's pacing must not follow the
    # viewer, and the viewer's cap must not loosen the sweep.
    assert flist_api.cdn_rate_limiter().per_second == 2.0
    # And nothing here touches the budget that limits how many
    # profiles can be opened in an hour.
    assert flist_api.unpaced_limiter().per_hour_cap > flist_api.HARD_PER_HOUR


@pytest.mark.anyio
async def test_the_image_gate_is_shared_within_one_loop() -> None:
    import flist_api

    assert flist_api.foreign_image_gate() is flist_api.foreign_image_gate()


def test_image_route_downloads_through_the_gate_unpaced(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import flist_api

    _stub_fetch(monkeypatch, _profile())
    client.get("/foreign/character/Anexample Person")

    seen: list[Any] = []

    async def _capture(url, dest, *, client=None, rate_limiter=None):
        seen.append(rate_limiter)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"PNGDATA")
        return 7

    monkeypatch.setattr(flist_api, "download_to", _capture)
    res = client.get("/foreign/character/Anexample Person/image/900")
    assert res.status_code == 200
    # The sweep's 2/s limiter must not be what a gallery queues behind.
    assert seen == [flist_api.unpaced_limiter()]
    assert seen[0] is not flist_api.cdn_rate_limiter()


def test_image_route_404s_when_the_profile_was_never_opened(
    client: TestClient,
) -> None:
    res = client.get("/foreign/character/Never Opened/image/900")
    assert res.status_code == 404


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
