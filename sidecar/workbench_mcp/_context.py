"""Shared plumbing for the MCP tools: errors, addressing, auditing.

Tools address characters and working sets the way a human would — by
name — instead of by the numeric character id and 12-hex set id the
REST API uses. Everything that turns a human string into an on-disk
identity lives here so the rules stay identical across ~70 tools.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import character_archive
import flist_activity
import logs as log_store

#: Sentinel a `set` argument can carry to address the read-only
#: `live.json` pulled from F-list rather than an editable working set.
LIVE = "live"


class ToolError(Exception):
    """A tool failure with a stable machine-readable code (§4.5).

    The MCP SDK turns a raised exception into an `isError` result whose
    only payload is the string form, so the code and details have to
    survive in the text. Models read this, so it stays readable:
    `not_signed_in: ... {"detail": ...}`.
    """

    def __init__(self, code: str, message: str, **details: Any) -> None:
        self.code = code
        self.message = message
        self.details = details
        rendered = f"{code}: {message}"
        if details:
            rendered += " " + json.dumps(details, ensure_ascii=False, default=str)
        super().__init__(rendered)


def not_signed_in() -> ToolError:
    return ToolError(
        "not_signed_in",
        "No F-list session. The user signs in inside the Workbench "
        "window (F-list → Sign in); there is no sign-in tool on "
        "purpose, because credentials never travel through MCP.",
    )


def confirm_required(what: str) -> ToolError:
    return ToolError(
        "confirm_required",
        f"{what} is destructive and permanent. Ask the user, then call "
        "again with confirm=true.",
    )


def validation_failed(field: str, reason: str, allowed: Any = None) -> ToolError:
    details: dict[str, Any] = {"field": field, "reason": reason}
    if allowed is not None:
        details["allowed"] = allowed
    return ToolError("validation_failed", f"{field}: {reason}", **details)


# --------------------------------------------------------------------
# Character addressing
# --------------------------------------------------------------------


@dataclass(frozen=True)
class ResolvedCharacter:
    """A character that has an on-disk archive."""

    id: str
    name: str

    @property
    def dir(self):  # noqa: ANN201 — Path, kept lazy to avoid the import
        return character_archive.character_dir(self.id)


def _registry_rows() -> list[tuple[str, str]]:
    """`(character_id, name)` for every registered character."""
    rows: list[tuple[str, str]] = []
    for cid, entry in character_archive.load_registry().items():
        name = (entry.get("name") or "").strip()
        if name:
            rows.append((str(cid), name))
    return rows


def resolve_character(character: str) -> ResolvedCharacter:
    """Accept a character name (case-insensitive) or a character id.

    Raises `character_not_found` listing the available names, which is
    what lets a model recover from a typo without a second round trip.
    """
    if not isinstance(character, str) or not character.strip():
        raise validation_failed("character", "must be a character name or id")
    needle = character.strip()

    rows = _registry_rows()
    for cid, name in rows:
        if name.lower() == needle.lower():
            return ResolvedCharacter(id=cid, name=name)
    for cid, name in rows:
        if cid == needle:
            return ResolvedCharacter(id=cid, name=name)

    # The registry only knows characters that were pulled through the
    # current code path. Fall back to a directory walk so archives from
    # older builds (and legacy id-named folders) still resolve.
    for row in character_archive.list_archived_characters():
        name = str(row.get("name") or "")
        cid = str(row.get("id") or "")
        if name.lower() == needle.lower() or cid == needle:
            return ResolvedCharacter(id=cid, name=name or needle)

    known = sorted(
        {name for _, name in rows}
        | {
            str(r.get("name"))
            for r in character_archive.list_archived_characters()
            if r.get("name")
        }
    )
    raise ToolError(
        "character_not_found",
        f"No local archive for {needle!r}. Pull it first with "
        "pull_character, or pick one of the known characters.",
        known_characters=known,
    )


# --------------------------------------------------------------------
# Working-set addressing
# --------------------------------------------------------------------


@dataclass(frozen=True)
class ResolvedSet:
    """A working set, or the read-only live profile."""

    character: ResolvedCharacter
    id: str | None  # None ⇒ live.json
    name: str

    @property
    def is_live(self) -> bool:
        return self.id is None


def resolve_set(
    character: ResolvedCharacter,
    set_ref: str | None,
    *,
    allow_live: bool = True,
    for_write: bool = False,
) -> ResolvedSet:
    """Resolve `set` to a working set: by id, by name, `"live"`, or —
    when omitted — the character's active set.

    `for_write=True` refuses live and refuses "no active set" with a
    hint rather than silently picking something.
    """
    sets = character_archive.list_sets(character.id)

    if set_ref is not None and str(set_ref).strip().lower() == LIVE:
        if not allow_live or for_write:
            raise ToolError(
                "live_is_read_only",
                "'live' is the last profile pulled from F-list and is "
                "never edited. Create or pick a working set instead.",
            )
        return ResolvedSet(character=character, id=None, name="live")

    if set_ref is None or not str(set_ref).strip():
        active = character_archive.read_active_set_id(character.id)
        if active is None:
            raise ToolError(
                "no_active_set",
                f"{character.name} has no active working set. Pass an "
                "explicit set, or create one with create_working_set.",
                available_sets=[
                    {"id": s.id, "name": s.name} for s in sets
                ],
            )
        meta = character_archive.read_set_meta(character.id, active)
        return ResolvedSet(
            character=character,
            id=active,
            name=(meta.name if meta else active),
        )

    needle = str(set_ref).strip()
    for meta in sets:
        if meta.id == needle:
            return ResolvedSet(character=character, id=meta.id, name=meta.name)
    matches = [m for m in sets if m.name.lower() == needle.lower()]
    if len(matches) == 1:
        return ResolvedSet(
            character=character, id=matches[0].id, name=matches[0].name
        )
    if len(matches) > 1:
        raise ToolError(
            "ambiguous_set",
            f"{character.name} has {len(matches)} working sets named "
            f"{needle!r}. Address it by id.",
            candidates=[{"id": m.id, "name": m.name} for m in matches],
        )
    raise ToolError(
        "set_not_found",
        f"{character.name} has no working set {needle!r}.",
        available_sets=[{"id": m.id, "name": m.name} for m in sets],
    )


def load_payload(target: ResolvedSet) -> dict[str, Any]:
    """Read the payload behind a resolved set (or the live profile)."""
    if target.is_live:
        live = character_archive.read_live(target.character.id)
        if live is None:
            raise ToolError(
                "live_not_found",
                f"No live profile stored for {target.character.name}. "
                "Run pull_character first.",
            )
        return live
    payload = character_archive.read_set_payload(target.character.id, target.id or "")
    if payload is None:
        raise ToolError(
            "set_not_found",
            f"Working set {target.name!r} has no payload on disk.",
        )
    return payload


# --------------------------------------------------------------------
# Auditing
# --------------------------------------------------------------------


def audit(tool_name: str, **fields: Any) -> None:
    """Record an MCP-initiated change in the F-list activity log.

    Every write tool calls this so the Help → F-list Activity Log modal
    shows what a model did, attributed to the tool by name.
    """
    try:
        flist_activity.record(f"mcp:{tool_name}", source="mcp", **fields)
    except Exception:  # noqa: BLE001 — auditing must never fail a tool
        pass


# --------------------------------------------------------------------
# Log addressing
# --------------------------------------------------------------------


@dataclass(frozen=True)
class ResolvedConversation:
    """One conversation, spelled the way the log store spells it."""

    character: str
    partner: str


def _log_dir_unavailable(exc: Exception) -> ToolError:
    return ToolError(
        "log_dir_unavailable",
        f"{exc} The F-Chat data directory is set in Settings → General.",
    )


def resolve_log_character(character: str, *, required: bool = True) -> str:
    """Accept a log character name case-insensitively; return the on-disk
    spelling.

    Necessary because the two halves of a label lookup disagree about
    case. Messages come off the filesystem, which is case-insensitive on
    Windows, so `lady amber blaise` opens the right directory. The
    `labels` and `partner_aliases` tables are keyed on the string the
    caller passed and match it exactly, so the same call finds no
    verdicts and no alias group. The result is not an error but a
    plausible-looking count with `ic: 0` and every judged message back in
    `unlabeled`. Resolving once, here, keeps both halves in agreement.

    `required=False` canonicalises without insisting the character has
    logs — for tools that only touch the labels DB, where a character
    may legitimately have rows but no log directory.
    """
    if not isinstance(character, str) or not character.strip():
        raise validation_failed("character", "must be a log character name")
    needle = character.strip().lower()
    try:
        entries = log_store.list_characters()
    except log_store.LogDirError as exc:
        if not required:
            return character.strip()
        raise _log_dir_unavailable(exc) from exc
    for entry in entries:
        if entry.name.lower() == needle:
            return entry.name
    if not required:
        return character.strip()
    raise ToolError(
        "log_character_not_found",
        f"No F-Chat logs for {character.strip()!r}.",
        known_characters=sorted(e.name for e in entries),
    )


def resolve_conversation(character: str, partner: str) -> ResolvedConversation:
    """Resolve both halves of a conversation address to their on-disk
    spelling. Alias members resolve to their group's primary, so callers
    never have to think about which name a log file was written under.
    """
    name = resolve_log_character(character)
    if not isinstance(partner, str) or not partner.strip():
        raise validation_failed("partner", "must be a partner name")
    needle = partner.strip().lower()
    try:
        entries = log_store.list_partners(name)
    except log_store.LogDirError as exc:
        raise _log_dir_unavailable(exc) from exc
    for entry in entries:
        if entry.name.lower() == needle or any(
            alt.lower() == needle for alt in entry.aliases
        ):
            return ResolvedConversation(character=name, partner=entry.name)
    close = sorted(e.name for e in entries if needle in e.name.lower())[:10]
    raise ToolError(
        "partner_not_found",
        f"{name} has no conversation with {partner.strip()!r}. "
        "Call list_partners for the names as they are stored.",
        did_you_mean=close,
    )
