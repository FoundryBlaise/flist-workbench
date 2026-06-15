"""F-list eicon catalog. Mirrors the Horizon F-Chat fork's approach:

- Full catalog fetched from xariah.net once and cached to disk as
  `eicons.json` ({version, asOfTimestamp, records: [str, ...]}).
- Subsequent launches fetch only the delta since the cached timestamp.
- Hourly background refresh.

The renderer doesn't talk to xariah.net directly — that keeps the
catalog access centralised, gives us one disk cache for the whole app,
and lets the renderer search a pre-loaded set without re-fetching on
every popover open.

Endpoint contract surfaced to the renderer:
    GET /eicons/search?q=<query>&limit=<n>
        -> { eicons: [str, ...], total: int, as_of: int, status: str }

`status` is one of 'ready' | 'loading' | 'error'. The renderer can use
'loading' to show a spinner before the first fetch lands.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

import httpx

import documents

log = logging.getLogger(__name__)

FULL_DATA_URL = "https://xariah.net/eicons/Home/EiconsDataBase/base.doc"
DELTA_URL = "https://xariah.net/eicons/Home/EiconsDataDeltaSince"
STORE_VERSION = 2
UPDATE_INTERVAL_S = 60 * 60  # 1 hour
DEFAULT_LIMIT = 200


def _store_path() -> Path:
    base = documents.user_data_dir()
    base.mkdir(parents=True, exist_ok=True)
    return base / "eicons.json"


@dataclass
class EiconStore:
    records: list[str] = field(default_factory=list)
    as_of_timestamp: int = 0
    status: str = "loading"
    error: str | None = None
    _index: set[str] = field(default_factory=set)

    def _rebuild_index(self) -> None:
        self._index = set(self.records)

    def search(self, query: str, limit: int) -> list[str]:
        q = query.strip().lower()
        if not q:
            return self.records[:limit]
        prefix: list[str] = []
        contains: list[str] = []
        for name in self.records:
            if name.startswith(q):
                prefix.append(name)
            elif q in name:
                contains.append(name)
            if len(prefix) + len(contains) >= limit * 4:
                break
        prefix.sort()
        contains.sort()
        return (prefix + contains)[:limit]


_store = EiconStore()
_update_lock = asyncio.Lock()
_background_task: asyncio.Task | None = None


def _parse_full(text: str) -> tuple[list[str], int]:
    eicons: list[str] = []
    as_of = 0
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            if stripped.startswith("# As Of: "):
                try:
                    as_of = int(stripped[len("# As Of: "):])
                except ValueError:
                    pass
            continue
        name = stripped.split("\t", 1)[0].lower()
        if name:
            eicons.append(name)
    return eicons, as_of


def _parse_delta(text: str) -> tuple[list[tuple[str, str]], int]:
    """Returns (updates, as_of). Each update is (action, name)."""
    updates: list[tuple[str, str]] = []
    as_of = 0
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            if stripped.startswith("# As Of: "):
                try:
                    as_of = int(stripped[len("# As Of: "):])
                except ValueError:
                    pass
            continue
        parts = stripped.split("\t", 2)
        if len(parts) < 2:
            continue
        action, name = parts[0], parts[1].lower()
        if action in ("+", "-") and name:
            updates.append((action, name))
    return updates, as_of


def _save_to_disk() -> None:
    if not _store.records or _store.as_of_timestamp <= 0:
        return
    try:
        path = _store_path()
        payload = {
            "version": STORE_VERSION,
            "asOfTimestamp": _store.as_of_timestamp,
            "records": _store.records,
        }
        path.write_text(json.dumps(payload), encoding="utf-8")
    except OSError as e:
        log.warning("eicons: save failed: %s", e)


def _load_from_disk() -> bool:
    path = _store_path()
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        records = data.get("records") or []
        as_of = int(data.get("asOfTimestamp") or 0)
        if not records or not as_of:
            return False
        _store.records = [str(r).lower() for r in records if isinstance(r, str)]
        _store.as_of_timestamp = as_of
        _store._rebuild_index()
        _store.status = "ready"
        return True
    except (OSError, ValueError, json.JSONDecodeError) as e:
        log.warning("eicons: load failed: %s", e)
        return False


async def _fetch_full(client: httpx.AsyncClient) -> None:
    resp = await client.get(FULL_DATA_URL)
    resp.raise_for_status()
    records, as_of = _parse_full(resp.text)
    if records and as_of:
        _store.records = records
        _store.as_of_timestamp = as_of
        _store._rebuild_index()
        _store.status = "ready"
        _store.error = None
        _save_to_disk()


async def _fetch_delta(client: httpx.AsyncClient) -> None:
    resp = await client.get(f"{DELTA_URL}/{_store.as_of_timestamp}")
    resp.raise_for_status()
    updates, as_of = _parse_delta(resp.text)
    # Horizon falls back to full re-download when the delta is huge —
    # mirror that to avoid pathological merge work.
    if len(updates) > 2000:
        await _fetch_full(client)
        return
    added = 0
    removed = 0
    for action, name in updates:
        if action == "+":
            if name not in _store._index:
                _store._index.add(name)
                _store.records.append(name)
                added += 1
        elif action == "-":
            if name in _store._index:
                _store._index.discard(name)
                removed += 1
    if removed:
        _store.records = [r for r in _store.records if r in _store._index]
    if as_of:
        _store.as_of_timestamp = as_of
    if added or removed:
        _save_to_disk()


async def refresh(*, force: bool = False) -> None:
    """Ensure the in-memory store is populated. Idempotent. Safe to call
    on every server startup — a hot cache + delta fetch is the common
    path."""
    async with _update_lock:
        if _store.status == "loading" and not _store.records:
            _load_from_disk()
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=15.0)) as client:
                if force or not _store.records:
                    await _fetch_full(client)
                else:
                    await _fetch_delta(client)
        except (httpx.HTTPError, OSError) as e:
            log.warning("eicons: refresh failed: %s", e)
            if not _store.records:
                _store.status = "error"
            _store.error = str(e)


async def _background_loop() -> None:
    while True:
        try:
            await asyncio.sleep(UPDATE_INTERVAL_S)
            await refresh()
        except asyncio.CancelledError:
            return
        except Exception as e:  # noqa: BLE001 — background heartbeat must not crash
            log.warning("eicons: background refresh crashed: %s", e)


async def start() -> None:
    """Initialise the store on sidecar startup. Tries disk first, then
    fetches deltas; falls back to full fetch if disk is empty. Schedules
    an hourly refresh after the initial load completes."""
    global _background_task
    if _load_from_disk():
        # We have something to show immediately — kick the network update
        # in the background instead of blocking startup.
        asyncio.create_task(refresh())
    else:
        await refresh()
    if _background_task is None or _background_task.done():
        _background_task = asyncio.create_task(_background_loop())


def search(query: str, limit: int = DEFAULT_LIMIT) -> dict:
    limit = max(1, min(limit, 1000))
    results = _store.search(query, limit)
    return {
        "eicons": results,
        "total": len(_store.records),
        "as_of": _store.as_of_timestamp,
        "status": _store.status,
        "error": _store.error,
    }


def store_snapshot() -> EiconStore:
    """Test/debug accessor — not exposed via HTTP."""
    return _store


__all__ = ["start", "refresh", "search", "store_snapshot"]
