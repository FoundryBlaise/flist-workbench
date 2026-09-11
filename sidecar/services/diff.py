"""What changed between two versions of a profile.

D6 in docs/MCP_DESIGN.md asked whether to port the renderer's diff
engine or write a simpler structural one. This is the simpler one, and
it answers a different question than the renderer's does: the UI shows
a human a side-by-side rendering, while a model needs a list of facts
it can act on — "Species went from Human to Elf, three kinks changed,
the description grew by 400 characters".

Descriptions are summarised rather than diffed line by line. A model
that needs the text can read both with `get_description`; putting two
30 KB BBCode blobs in a tool result helps nobody.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import profile_fields


@dataclass
class FieldChange:
    label: str
    before: Any
    after: Any

    def to_dict(self) -> dict[str, Any]:
        return {"field": self.label, "before": self.before, "after": self.after}


@dataclass
class Diff:
    profile_fields: list[FieldChange] = field(default_factory=list)
    kinks: list[FieldChange] = field(default_factory=list)
    custom_kinks: list[dict[str, Any]] = field(default_factory=list)
    images: dict[str, Any] = field(default_factory=dict)
    settings: list[FieldChange] = field(default_factory=list)
    description: dict[str, Any] = field(default_factory=dict)
    custom_title: FieldChange | None = None

    @property
    def is_empty(self) -> bool:
        return not (
            self.profile_fields
            or self.kinks
            or self.custom_kinks
            or self.images
            or self.settings
            or self.description
            or self.custom_title
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.description:
            out["description"] = self.description
        if self.custom_title:
            out["custom_title"] = self.custom_title.to_dict()
        if self.profile_fields:
            out["profile_fields"] = [c.to_dict() for c in self.profile_fields]
        if self.kinks:
            out["kinks"] = [c.to_dict() for c in self.kinks]
        if self.custom_kinks:
            out["custom_kinks"] = self.custom_kinks
        if self.images:
            out["images"] = self.images
        if self.settings:
            out["settings"] = [c.to_dict() for c in self.settings]
        if not out:
            out["identical"] = True
        return out


def compare(
    before: dict[str, Any],
    after: dict[str, Any],
    catalogue: profile_fields.Catalogue,
) -> Diff:
    """Compare two payloads, naming everything the way F-list does."""
    diff = Diff()

    _compare_description(before, after, diff)
    _compare_custom_title(before, after, diff)
    _compare_infotags(before, after, catalogue, diff)
    _compare_kinks(before, after, catalogue, diff)
    _compare_custom_kinks(before, after, diff)
    _compare_images(before, after, diff)
    _compare_settings(before, after, diff)
    return diff


def _character(payload: dict[str, Any]) -> dict[str, Any]:
    char = payload.get("character")
    return char if isinstance(char, dict) else {}


def _compare_description(
    before: dict[str, Any], after: dict[str, Any], diff: Diff
) -> None:
    old = str(_character(before).get("description") or "")
    new = str(_character(after).get("description") or "")
    if old == new:
        return
    diff.description = {
        "changed": True,
        "length_before": len(old),
        "length_after": len(new),
        "delta_chars": len(new) - len(old),
        "note": (
            "Read both with get_description to see the text; a full diff "
            "of two BBCode blocks is not useful in a tool result."
        ),
    }


def _compare_custom_title(
    before: dict[str, Any], after: dict[str, Any], diff: Diff
) -> None:
    old = _character(before).get("custom_title")
    new = _character(after).get("custom_title")
    if old != new:
        diff.custom_title = FieldChange("custom_title", old, new)


def _compare_infotags(
    before: dict[str, Any],
    after: dict[str, Any],
    catalogue: profile_fields.Catalogue,
    diff: Diff,
) -> None:
    old = before.get("infotags") or {}
    new = after.get("infotags") or {}
    for key in sorted(set(old) | set(new), key=str):
        old_raw = old.get(key)
        new_raw = new.get(key)
        if old_raw == new_raw:
            continue
        field_def = catalogue.field_by_id(str(key))
        label = field_def.label if field_def else f"info_{key}"
        diff.profile_fields.append(
            FieldChange(
                label,
                _readable(field_def, old_raw),
                _readable(field_def, new_raw),
            )
        )


def _readable(field_def, raw: Any) -> Any:  # noqa: ANN001
    """A list field stores an option id; show the label instead."""
    if raw is None:
        return None
    if field_def is not None and field_def.type == "list":
        return field_def.option_label(str(raw)) or raw
    return raw


def _compare_kinks(
    before: dict[str, Any],
    after: dict[str, Any],
    catalogue: profile_fields.Catalogue,
    diff: Diff,
) -> None:
    old = before.get("kinks") or {}
    new = after.get("kinks") or {}
    if not isinstance(old, dict):
        old = {}
    if not isinstance(new, dict):
        new = {}
    for key in sorted(set(old) | set(new), key=str):
        old_choice = old.get(key)
        new_choice = new.get(key)
        if old_choice == new_choice:
            continue
        diff.kinks.append(
            FieldChange(
                catalogue.kinks.get(str(key), f"kink#{key}"),
                old_choice or "undecided",
                new_choice or "undecided",
            )
        )


def _live_custom_kinks(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = payload.get("custom_kinks") or {}
    if not isinstance(raw, dict):
        return {}
    return {
        key: value
        for key, value in raw.items()
        if isinstance(value, dict) and not value.get("_deleted")
    }


def _compare_custom_kinks(
    before: dict[str, Any], after: dict[str, Any], diff: Diff
) -> None:
    old = _live_custom_kinks(before)
    new = _live_custom_kinks(after)
    for key in sorted(set(old) | set(new), key=str):
        old_entry = old.get(key)
        new_entry = new.get(key)
        if old_entry is None:
            diff.custom_kinks.append(
                {"change": "added", "name": new_entry.get("name"), "id": key}
            )
        elif new_entry is None:
            diff.custom_kinks.append(
                {"change": "removed", "name": old_entry.get("name"), "id": key}
            )
        else:
            changed = {
                f: [old_entry.get(f), new_entry.get(f)]
                for f in ("name", "description", "choice")
                if old_entry.get(f) != new_entry.get(f)
            }
            if changed:
                diff.custom_kinks.append(
                    {
                        "change": "edited",
                        "name": new_entry.get("name"),
                        "id": key,
                        "fields": changed,
                    }
                )


def _gallery_ids(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("images")
    if not isinstance(raw, list):
        return []
    return [
        str(row.get("image_id"))
        for row in raw
        if isinstance(row, dict) and row.get("image_id") is not None
    ]


def _compare_images(
    before: dict[str, Any], after: dict[str, Any], diff: Diff
) -> None:
    old = _gallery_ids(before)
    new = _gallery_ids(after)
    if old == new:
        return
    added = [i for i in new if i not in old]
    removed = [i for i in old if i not in new]
    out: dict[str, Any] = {}
    if added:
        out["added"] = added
    if removed:
        out["removed"] = removed
    if not added and not removed:
        # Same images, different order — worth saying explicitly,
        # because the profile page renders in this order.
        out["reordered"] = True
        out["order_before"] = old
        out["order_after"] = new
    diff.images = out


def _compare_settings(
    before: dict[str, Any], after: dict[str, Any], diff: Diff
) -> None:
    old = before.get("settings") or {}
    new = after.get("settings") or {}
    if not isinstance(old, dict):
        old = {}
    if not isinstance(new, dict):
        new = {}
    for key in sorted(set(old) | set(new)):
        if old.get(key) != new.get(key):
            diff.settings.append(FieldChange(key, old.get(key), new.get(key)))
