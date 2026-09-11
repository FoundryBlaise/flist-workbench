"""Resolving F-list's mapping list into usable field descriptions.

A profile payload stores raw ids: `infotags: {"9": "3"}` means "the
field with id 9 is set to list option 3". Only the mapping list turns
that into "Species: Human". The renderer has always done this
(`features/flist/infotagsResolver.ts`); the MCP tools need the same
thing server-side, because a model asked to "set her height to 175 cm"
has to find the height field by name and validate the value.

This is a port of that resolver, plus the kink catalogue from
`kinksUnified.ts`. Kept deliberately close to the originals so the two
stay comparable when F-list's payload shape drifts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Literal

FieldType = Literal["text", "list", "number", "unknown"]

#: Choices a standard kink can carry.
KINK_CHOICES = ("fave", "yes", "maybe", "no")

#: What the UI shows for a kink with no stored choice. Never written to
#: the payload — an undecided kink is simply absent.
UNDECIDED = "undecided"


@dataclass(frozen=True)
class ListOption:
    value: str
    label: str

    def to_dict(self) -> dict[str, str]:
        return {"value": self.value, "label": self.label}


@dataclass(frozen=True)
class ProfileField:
    """One infotag, as a model should see it."""

    id: str
    label: str
    type: FieldType
    group: str | None
    options: list[ListOption] = field(default_factory=list)

    def to_dict(self, value: Any = None) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "type": self.type,
        }
        if self.group:
            out["group"] = self.group
        if self.options:
            out["options"] = [o.label for o in self.options]
        if value is not None:
            out["value"] = value
            if self.type == "list":
                resolved = self.option_label(str(value))
                if resolved is not None:
                    out["value"] = resolved
                    out["raw_value"] = str(value)
        return out

    def option_label(self, value: str) -> str | None:
        for option in self.options:
            if option.value == value:
                return option.label
        return None

    def option_value(self, wanted: str) -> str | None:
        """Accept either the option's id or its label, case-insensitively."""
        needle = wanted.strip()
        for option in self.options:
            if option.value == needle:
                return option.value
        for option in self.options:
            if option.label.lower() == needle.lower():
                return option.value
        return None


@dataclass(frozen=True)
class Catalogue:
    """Everything the mapping list describes, indexed for lookup."""

    fields: list[ProfileField]
    kinks: dict[str, str]  # kink id → name
    kink_groups: dict[str, str]  # group id → name
    kink_group_of: dict[str, str]  # kink id → group id

    def field_by_id(self, field_id: str) -> ProfileField | None:
        for f in self.fields:
            if f.id == field_id:
                return f
        return None

    def resolve_field(self, wanted: str) -> ProfileField | None:
        """Find a field by id, by `info_<id>`, or by label."""
        needle = wanted.strip()
        if needle.lower().startswith("info_"):
            needle = needle[len("info_") :]
        exact = self.field_by_id(needle)
        if exact is not None:
            return exact
        for f in self.fields:
            if f.label.lower() == needle.lower():
                return f
        return None

    def kink_id_for(self, wanted: str) -> str | None:
        """Find a standard kink by id or by name, case-insensitively."""
        needle = wanted.strip()
        if needle in self.kinks:
            return needle
        for kink_id, name in self.kinks.items():
            if name.lower() == needle.lower():
                return kink_id
        return None

    @property
    def is_empty(self) -> bool:
        return not self.fields and not self.kinks


EMPTY = Catalogue(fields=[], kinks={}, kink_groups={}, kink_group_of={})


def build(mapping: dict[str, Any] | None) -> Catalogue:
    """Resolve a raw mapping-list payload into a `Catalogue`."""
    if not isinstance(mapping, dict):
        return EMPTY

    # F-list keys listitems by *category name* ("orientation"), not by
    # id; each infotag's `list` field is that category name. Bucket them
    # in one pass so dropdown choices resolve without a nested scan.
    options_by_category: dict[str, list[ListOption]] = {}
    label_by_id: dict[str, str] = {}
    for entry in _iter_dicts(mapping.get("listitems")):
        raw_id = entry.get("id")
        if raw_id is None:
            continue
        value = str(raw_id)
        label = str(entry.get("value") or "")
        label_by_id[value] = label
        name = entry.get("name")
        if isinstance(name, str) and name:
            options_by_category.setdefault(name, []).append(
                ListOption(value=value, label=label)
            )

    group_names = {
        str(g["id"]): str(g.get("name") or g.get("label") or g["id"])
        for g in _iter_dicts(mapping.get("infotag_groups"))
        if g.get("id") is not None
    }

    fields: list[ProfileField] = []
    for entry in _iter_dicts(mapping.get("infotags")):
        raw_id = entry.get("id")
        if raw_id is None:
            continue
        field_id = str(raw_id)
        name = entry.get("name")
        label = name if isinstance(name, str) and name.strip() else f"info_{field_id}"
        declared = entry.get("type") if isinstance(entry.get("type"), str) else ""

        options: list[ListOption] = []
        if declared == "list":
            listref = entry.get("list")
            if isinstance(listref, str) and listref:
                options = options_by_category.get(listref, [])
            elif isinstance(listref, list):
                # Defensive: handles a future shape where F-list inlines
                # the options instead of pointing at a category.
                options = _inline_options(listref, label_by_id)
            # A list field with no resolvable options is unusable as a
            # dropdown; treat it as free text rather than rejecting
            # every value the user tries to set.
            field_type: FieldType = "list" if options else "text"
        elif declared in ("number", "text"):
            field_type = declared  # type: ignore[assignment]
        else:
            field_type = "unknown"

        raw_group = entry.get("group_id")
        group_id = str(raw_group) if raw_group not in (None, "") else None
        fields.append(
            ProfileField(
                id=field_id,
                label=label,
                type=field_type,
                group=group_names.get(group_id or "", group_id),
                options=options,
            )
        )

    kinks: dict[str, str] = {}
    kink_group_of: dict[str, str] = {}
    for entry in _iter_dicts(mapping.get("kinks")):
        raw_id = entry.get("id")
        if raw_id is None:
            continue
        kink_id = str(raw_id)
        name = entry.get("name")
        kinks[kink_id] = name if isinstance(name, str) else f"kink#{kink_id}"
        raw_group = entry.get("group_id")
        kink_group_of[kink_id] = str(raw_group) if raw_group is not None else "misc"

    kink_groups = {
        str(g["id"]): str(g.get("name") or f"group#{g['id']}")
        for g in _iter_dicts(mapping.get("kink_groups"))
        if g.get("id") is not None
    }

    return Catalogue(
        fields=fields,
        kinks=kinks,
        kink_groups=kink_groups,
        kink_group_of=kink_group_of,
    )


def _iter_dicts(raw: Any) -> Iterable[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    return [entry for entry in raw if isinstance(entry, dict)]


def _inline_options(
    raw: list[Any], label_by_id: dict[str, str]
) -> list[ListOption]:
    out: list[ListOption] = []
    for item in raw:
        if isinstance(item, dict):
            if item.get("id") is None:
                continue
            value = str(item["id"])
            out.append(
                ListOption(
                    value=value,
                    label=str(item.get("value") or label_by_id.get(value) or value),
                )
            )
        elif isinstance(item, (str, int)):
            value = str(item)
            out.append(ListOption(value=value, label=label_by_id.get(value, value)))
    return out


# --------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------


class FieldValidationError(ValueError):
    """A value doesn't fit the field it was aimed at."""

    def __init__(self, field_name: str, reason: str, allowed: Any = None) -> None:
        self.field_name = field_name
        self.reason = reason
        self.allowed = allowed
        super().__init__(f"{field_name}: {reason}")


def coerce_value(field_def: ProfileField, value: Any) -> str:
    """Turn a user-supplied value into what the payload should store.

    `list` fields store the option id, so a label is translated. Numbers
    are checked for numeric-ness. Fields the mapping list doesn't
    describe are refused — writing an id F-list doesn't know produces a
    profile that silently drops the field on upload.
    """
    if field_def.type == "unknown":
        raise FieldValidationError(
            field_def.label,
            "the mapping list doesn't describe this field, so a value "
            "written here would be dropped when the profile is uploaded",
        )

    text = "" if value is None else str(value).strip()
    if not text:
        raise FieldValidationError(
            field_def.label,
            "empty. Use clear_profile_field to remove a field instead of "
            "setting it to an empty string",
        )

    if field_def.type == "list":
        resolved = field_def.option_value(text)
        if resolved is None:
            raise FieldValidationError(
                field_def.label,
                f"{text!r} is not one of this field's options",
                allowed=[o.label for o in field_def.options],
            )
        return resolved

    if field_def.type == "number":
        try:
            float(text.replace(",", "."))
        except ValueError:
            raise FieldValidationError(
                field_def.label, f"{text!r} is not a number"
            ) from None
        return text

    return text


def validate_kink_choice(choice: Any) -> str:
    """Normalise a standard-kink choice, or raise."""
    text = str(choice or "").strip().lower()
    if text in KINK_CHOICES:
        return text
    if text == UNDECIDED:
        return UNDECIDED
    raise FieldValidationError(
        "choice",
        f"{choice!r} is not a kink choice",
        allowed=[*KINK_CHOICES, UNDECIDED],
    )
