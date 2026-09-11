"""Editing a working-set payload, with the rules the renderer enforces.

Until now the only thing that wrote a payload was the React editor, so
a pile of invariants lived in `renderer/src/state.ts` and
`state/flist.ts` and nowhere else. The sidecar happily accepted a PUT
that broke any of them. That was fine while the UI was the only writer;
it is not fine now that a language model can write through MCP.

What this module guarantees, all of it ported from the renderer:

* **Overlay bookkeeping.** `_overlay` lists the dotted paths the user
  has touched. It is what lets a later pull refresh untouched fields
  without clobbering edits — an edit that doesn't extend the overlay is
  silently reverted by the next pull.
* **Clearing a field deletes its key.** Writing `""` into an infotag
  publishes an empty field instead of removing it.
* **`kinks: []` becomes `{}`.** F-list sends an empty list; anything
  that then sets a key on it produces a list with a named property,
  which does not survive a JSON round trip.
* **Gallery order is 0..n-1.** F-list renders by `sort_order`, so gaps
  or duplicates reorder the profile in ways nobody asked for.
* **Deleting a custom kink means two different things.** One that
  exists on F-list gets a `_deleted: true` tombstone, which is how the
  exporter knows to remove it. One that only ever existed locally
  (`local:<uuid>`) is dropped outright — there is nothing to remove.
* **Descriptions normalise CRLF to LF.**

Every mutation goes through `edit()`, which reads the payload, applies
a change function, and writes it back under the etag it read — retrying
once if the UI saved in between.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

import character_archive

#: Top-level payload keys that hold content, as opposed to bookkeeping.
CONTAINER_KEYS = (
    "character",
    "settings",
    "infotags",
    "kinks",
    "custom_kinks",
    "images",
    "inlines",
)

DESCRIPTION_PATH = "character.description"
CUSTOM_KINK_ORDER_PATH = "custom_kinks._order"
IMAGES_PATH = "images"

#: Profile-visibility flags, and what each one means. Used to validate
#: `set_profile_settings` and to describe it to a model.
PROFILE_SETTINGS: dict[str, str] = {
    "customs_first": "show custom kinks above the standard ones",
    "show_friends": "show the friends list on the profile",
    "guestbook": "allow guestbook entries",
    "prevent_bookmarks": "stop others bookmarking this character",
    "public": "the profile is visible to guests, not just logged-in users",
}


class PayloadError(ValueError):
    """A change that would leave the payload invalid."""


@dataclass
class EditResult:
    """What an edit did, for reporting back to the caller."""

    etag: str
    changed: list[str] = field(default_factory=list)
    detail: dict[str, Any] = field(default_factory=dict)


def normalise_newlines(text: str) -> str:
    """F-list serves descriptions with literal CRLF; the editor stores
    LF. Mixing them makes a diff show every line as changed."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def new_local_kink_id() -> str:
    """Id for a custom kink that doesn't exist on F-list yet.

    The `local:` prefix is load-bearing: deleting such a kink removes
    it outright, while deleting one F-list knows about leaves a
    tombstone so the exporter removes it from the profile.
    """
    return f"local:{uuid.uuid4()}"


# --------------------------------------------------------------------
# The edit transaction
# --------------------------------------------------------------------


def edit(
    character_id: str,
    set_id: str,
    mutate: Callable[[dict[str, Any]], EditResult | None],
) -> EditResult:
    """Read a payload, apply `mutate`, write it back under its etag.

    `mutate` changes the payload in place and returns an `EditResult`
    carrying the paths it touched (its `etag` is filled in here). A
    409 means the Workbench window saved while we were working; the
    edit is re-applied once against the fresh payload rather than
    failing, because the two writers are usually touching different
    fields.
    """
    for attempt in (1, 2):
        payload = character_archive.read_set_payload(character_id, set_id)
        if payload is None:
            raise PayloadError(f"working set {set_id} has no payload on disk")
        etag = character_archive.set_payload_etag(character_id, set_id)

        result = mutate(payload) or EditResult(etag="")
        _finalise(payload, result.changed)

        try:
            new_etag = character_archive.write_set_payload(
                character_id, set_id, payload, expected_etag=etag
            )
        except character_archive.EtagMismatch:
            if attempt == 1:
                continue
            raise
        result.etag = new_etag
        return result

    raise AssertionError("unreachable")  # pragma: no cover


def _finalise(payload: dict[str, Any], changed: Iterable[str]) -> None:
    """Fold the touched paths into `_overlay` and tidy the payload."""
    overlay = payload.get("_overlay")
    if not isinstance(overlay, list):
        overlay = []
    seen = {p for p in overlay if isinstance(p, str)}
    for path in changed:
        if path not in seen:
            overlay.append(path)
            seen.add(path)
    payload["_overlay"] = [p for p in overlay if isinstance(p, str)]

    # F-list sends `kinks: []` for a character with none set. Setting a
    # key on that would produce a list carrying a named property.
    if isinstance(payload.get("kinks"), list):
        payload["kinks"] = {}


def drop_overlay(payload: dict[str, Any], prefix: str) -> None:
    """Remove overlay entries for a path and everything under it.

    Used when a custom kink is deleted outright: leaving
    `custom_kinks.local:x.name` in the overlay would resurrect the id
    as an empty stub on the next reset.
    """
    overlay = payload.get("_overlay")
    if not isinstance(overlay, list):
        return
    payload["_overlay"] = [
        p
        for p in overlay
        if isinstance(p, str) and p != prefix and not p.startswith(prefix + ".")
    ]


# --------------------------------------------------------------------
# Field-level operations
# --------------------------------------------------------------------


def container(payload: dict[str, Any], key: str) -> dict[str, Any]:
    """A dict container from the payload, created if absent.

    Coerces a list to a dict — see the `kinks: []` note above.
    """
    current = payload.get(key)
    if not isinstance(current, dict):
        current = {}
        payload[key] = current
    return current


def set_description(payload: dict[str, Any], text: str) -> None:
    char = container(payload, "character")
    char["description"] = normalise_newlines(str(text))


def get_description(payload: dict[str, Any]) -> str:
    char = payload.get("character")
    if not isinstance(char, dict):
        return ""
    return str(char.get("description") or "")


def set_infotag(payload: dict[str, Any], field_id: str, value: str) -> str:
    """Store a profile field. Returns the overlay path."""
    tags = container(payload, "infotags")
    tags[str(field_id)] = value
    return f"infotags.{field_id}"


def clear_infotag(payload: dict[str, Any], field_id: str) -> tuple[str, bool]:
    """Remove a profile field entirely. Returns (overlay path, existed).

    The key is deleted rather than set to `""` — an empty string is a
    value F-list publishes, which is not what "clear this" means.
    """
    tags = container(payload, "infotags")
    existed = str(field_id) in tags
    tags.pop(str(field_id), None)
    return f"infotags.{field_id}", existed


def set_kink(payload: dict[str, Any], kink_id: str, choice: str) -> str:
    """Set or unset a standard kink. `undecided` removes the entry —
    that is how F-list represents "no opinion"."""
    kinks = container(payload, "kinks")
    key = str(kink_id)
    if choice == "undecided":
        kinks.pop(key, None)
    else:
        kinks[key] = choice
    return f"kinks.{key}"


# --------------------------------------------------------------------
# Custom kinks
# --------------------------------------------------------------------


def custom_kink_order(payload: dict[str, Any]) -> list[str]:
    """The display order, defaulting to dict insertion order."""
    order = payload.get("_custom_kinks_order")
    kinks = container(payload, "custom_kinks")
    if isinstance(order, list):
        known = [k for k in order if isinstance(k, str) and k in kinks]
        # Anything added without touching the order list still has to
        # appear, or it would silently vanish from the profile.
        known.extend(k for k in kinks if k not in known)
        return known
    return list(kinks)


def add_custom_kink(
    payload: dict[str, Any], name: str, description: str, choice: str
) -> tuple[str, list[str]]:
    """Append a custom kink. Returns (id, overlay paths)."""
    kink_id = new_local_kink_id()
    kinks = container(payload, "custom_kinks")
    kinks[kink_id] = {
        "name": name,
        "description": description,
        "choice": choice,
        "children": [],
    }
    order = custom_kink_order(payload)
    if kink_id not in order:
        order.append(kink_id)
    payload["_custom_kinks_order"] = order
    return kink_id, [
        CUSTOM_KINK_ORDER_PATH,
        f"custom_kinks.{kink_id}.name",
        f"custom_kinks.{kink_id}.description",
        f"custom_kinks.{kink_id}.choice",
    ]


def update_custom_kink(
    payload: dict[str, Any], kink_id: str, **fields: Any
) -> list[str]:
    """Change name / description / choice on an existing custom kink."""
    kinks = container(payload, "custom_kinks")
    entry = kinks.get(kink_id)
    if not isinstance(entry, dict):
        raise PayloadError(f"no custom kink with id {kink_id!r}")
    touched: list[str] = []
    for key, value in fields.items():
        if value is None:
            continue
        entry[key] = value
        touched.append(f"custom_kinks.{kink_id}.{key}")
    return touched


def delete_custom_kink(payload: dict[str, Any], kink_id: str) -> tuple[str, list[str]]:
    """Remove a custom kink. Returns (how, overlay paths).

    `how` is "tombstoned" for a kink F-list knows about — the entry
    stays with `_deleted: true` so the exporter removes it from the
    profile — or "dropped" for a `local:` one that was never uploaded
    and can simply go.
    """
    kinks = container(payload, "custom_kinks")
    if kink_id not in kinks:
        raise PayloadError(f"no custom kink with id {kink_id!r}")

    order = custom_kink_order(payload)
    if kink_id.startswith("local:"):
        del kinks[kink_id]
        payload["_custom_kinks_order"] = [k for k in order if k != kink_id]
        drop_overlay(payload, f"custom_kinks.{kink_id}")
        return "dropped", [CUSTOM_KINK_ORDER_PATH]

    entry = kinks[kink_id]
    if not isinstance(entry, dict):
        entry = {}
        kinks[kink_id] = entry
    entry["_deleted"] = True
    payload["_custom_kinks_order"] = order
    return "tombstoned", [f"custom_kinks.{kink_id}._deleted"]


def restore_custom_kink(payload: dict[str, Any], kink_id: str) -> list[str]:
    """Undo a tombstone. A dropped `local:` kink cannot be restored —
    nothing was kept."""
    kinks = container(payload, "custom_kinks")
    entry = kinks.get(kink_id)
    if not isinstance(entry, dict):
        raise PayloadError(
            f"no custom kink with id {kink_id!r}. A deleted local kink is "
            "gone for good; add it again."
        )
    if not entry.pop("_deleted", None):
        raise PayloadError(f"custom kink {kink_id!r} is not deleted")
    drop_overlay(payload, f"custom_kinks.{kink_id}._deleted")
    return [f"custom_kinks.{kink_id}.choice"]


def reorder_custom_kinks(payload: dict[str, Any], ids: list[str]) -> list[str]:
    """Set the display order. Every live kink must appear exactly once."""
    kinks = container(payload, "custom_kinks")
    live = {k for k, v in kinks.items() if not (isinstance(v, dict) and v.get("_deleted"))}
    given = list(ids)
    if len(set(given)) != len(given):
        raise PayloadError("the order contains a duplicate id")
    unknown = [k for k in given if k not in kinks]
    if unknown:
        raise PayloadError(f"unknown custom kink id(s): {', '.join(unknown)}")
    missing = live - set(given)
    if missing:
        raise PayloadError(
            "the order must list every custom kink; missing: "
            + ", ".join(sorted(missing))
        )
    # Tombstoned entries keep their place at the end so restoring one
    # doesn't drop it into an arbitrary slot.
    tail = [k for k in custom_kink_order(payload) if k not in given]
    payload["_custom_kinks_order"] = given + tail
    return [CUSTOM_KINK_ORDER_PATH]


# --------------------------------------------------------------------
# Gallery
# --------------------------------------------------------------------


def gallery(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """The gallery rows, sorted by `sort_order`."""
    raw = payload.get("images")
    if not isinstance(raw, list):
        return []
    rows: list[dict[str, Any]] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            continue
        image_id = entry.get("image_id") or entry.get("id")
        if image_id is None:
            continue
        order = entry.get("sort_order")
        try:
            order_int = int(order)
        except (TypeError, ValueError):
            order_int = index
        rows.append(
            {
                "image_id": str(image_id),
                "description": str(entry.get("description") or ""),
                "sort_order": order_int,
            }
        )
    rows.sort(key=lambda r: r["sort_order"])
    return rows


def set_gallery(payload: dict[str, Any], rows: list[dict[str, Any]]) -> list[str]:
    """Replace the gallery, renumbering `sort_order` to 0..n-1.

    F-list renders by `sort_order`, so a gap or a duplicate silently
    reorders the profile.
    """
    payload["images"] = [
        {
            "image_id": str(row["image_id"]),
            "description": str(row.get("description") or ""),
            "sort_order": index,
        }
        for index, row in enumerate(rows)
    ]
    return [IMAGES_PATH]


# --------------------------------------------------------------------
# Profile settings
# --------------------------------------------------------------------


def set_profile_settings(payload: dict[str, Any], values: dict[str, Any]) -> list[str]:
    settings = container(payload, "settings")
    touched: list[str] = []
    for key, value in values.items():
        if value is None:
            continue
        if key not in PROFILE_SETTINGS:
            raise PayloadError(
                f"unknown profile setting {key!r}; allowed: "
                + ", ".join(sorted(PROFILE_SETTINGS))
            )
        settings[key] = bool(value)
        touched.append(f"settings.{key}")
    if not touched:
        raise PayloadError("no settings given")
    return touched


# --------------------------------------------------------------------
# Seeding
# --------------------------------------------------------------------


def seed_from_live(live: dict[str, Any]) -> dict[str, Any]:
    """Build a fresh working payload from a pulled profile.

    One implementation, used by every caller. There used to be three —
    `character_archive._seed_payload_from_live`, a copy in `server.py`,
    and `seedWorkingFromLive` in the renderer — which drifted.
    """
    return character_archive._seed_payload_from_live(live)
