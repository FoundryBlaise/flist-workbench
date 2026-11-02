"""Look-ups for the editor: the eicon catalogue and a public profile."""

from fastapi import APIRouter

import character_archive
import eicons as eicons_catalog
import flist_api
from refusals import FlistRefused

router = APIRouter()


@router.get("/eicons/search")
def eicons_search(q: str = "", limit: int = 200) -> dict:
    """Search the cached eicon catalog (sourced from xariah.net).

    The renderer uses this to populate the toolbar's eicon picker. The
    catalog is loaded into memory at sidecar startup with delta refreshes
    every hour. While the first fetch is in flight `status` will be
    'loading'; the renderer should poll or show a spinner.
    """
    return eicons_catalog.search(q, limit)


@router.get("/profile/{name}")
async def profile(name: str) -> dict:
    """Public profile fetch routed through the F-list JSON API.

    Replaces the previous HTML scrape (`flist.fetch_profile`). The shape
    returned here matches the old `Profile.to_dict()` so existing
    renderer code in EditorPane's "Fetch profile" button still works
    against it. Requires an active sign-in — 401 surfaces a "Sign in to
    F-list first" CTA in the renderer.
    """
    try:
        payload = await flist_api.fetch_character_data(name)
    except flist_api.TicketRequired as exc:
        raise FlistRefused("not_signed_in", "not signed in to F-list") from exc
    except flist_api.FlistApiError as exc:
        msg = str(exc).lower()
        if not isinstance(exc, flist_api.RateLimited) and (
            "no such character" in msg or "not found" in msg
        ):
            raise FlistRefused("not_found", f"character not found: {name}") from exc
        raise flist_api.refusal(exc) from exc

    resolved_name = payload.get("name") or name
    # F-list serves descriptions with literal CRLF / CR line endings.
    # CodeMirror tolerates them but our contentEditable PreviewPane +
    # BBCode→HTML transformer render them as visible artifacts. Match
    # what the old HTML-scrape path did (flist.parse_profile) and
    # normalise to LF for editor consumers.
    description = (payload.get("description") or "").replace("\r\n", "\n").replace("\r", "\n")
    inlines_raw = payload.get("inlines")
    inlines: dict[str, dict] = {}
    if isinstance(inlines_raw, dict):
        for k, v in inlines_raw.items():
            if isinstance(v, dict):
                inlines[str(k)] = v

    # Stats are rendered as a key:value list in the editor's profile
    # pane. We resolve infotag IDs → labels via the cached mapping list
    # so the user sees "Age: 28" instead of "info_1: 28".
    stats: dict[str, str] = {}
    infotags = payload.get("infotags")
    if isinstance(infotags, dict) and infotags:
        try:
            mapping = await flist_api.fetch_mapping_list(
                character_archive.cache_root() / "mapping-list.json"
            )
            stats = _resolve_infotag_stats(infotags, mapping)
        except flist_api.FlistApiError:
            # Mapping fetch failure is non-fatal for description-lookup
            # — surface raw infotag IDs so the user still gets the
            # BBCode they came for.
            stats = {f"info_{k}": str(v) for k, v in infotags.items()}

    return {
        "name": resolved_name,
        "avatar_url": flist_api.avatar_url(resolved_name),
        "bbcode": description,
        "stats": stats,
        "inlines": inlines,
    }


def _resolve_infotag_stats(
    infotags: dict, mapping: dict
) -> dict[str, str]:
    """Resolve `{infotag_id: value}` → `{label: human_value}` using the
    mapping list. Enum infotags have list IDs as values; we look up the
    list-item label too."""
    out: dict[str, str] = {}
    infotag_meta = {}
    raw_infotags = mapping.get("infotags")
    if isinstance(raw_infotags, list):
        for entry in raw_infotags:
            if isinstance(entry, dict) and entry.get("id") is not None:
                infotag_meta[str(entry["id"])] = entry
    listitems_meta: dict[str, str] = {}
    raw_listitems = mapping.get("listitems")
    if isinstance(raw_listitems, list):
        for entry in raw_listitems:
            if isinstance(entry, dict) and entry.get("id") is not None:
                listitems_meta[str(entry["id"])] = entry.get("value", "")
    for raw_id, raw_value in infotags.items():
        meta = infotag_meta.get(str(raw_id))
        label = (meta or {}).get("name") or f"info_{raw_id}"
        text = str(raw_value)
        # Enum-type infotags: value is a listitem id whose label lives
        # in `listitems[*].value`.
        if (meta or {}).get("type") == "list":
            text = listitems_meta.get(text, text)
        out[label] = text
    return out
