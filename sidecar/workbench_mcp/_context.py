"""Shared plumbing for the MCP tools: errors, addressing, auditing.

Tools address characters the way a human would — by name — instead of
by the numeric character id the REST API uses, and a profile as the
character's Workbench or its Live. Everything that turns a human
string into an on-disk identity lives here so the rules stay identical
across every tool.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import archive_live
import archive_registry
import archive_workbench
import flist_activity
import logs as log_store
from refusals import Refusal

#: Sentinel a `working_set` argument can carry to address the read-only
#: `live.json` pulled from F-list rather than the editable Workbench.
LIVE = "live"


class ToolError(Exception):
    """A tool failure with a stable machine-readable code (§4.5).

    The MCP SDK turns a raised exception into an `isError` result whose
    only payload is the string form, so the code and details have to
    survive in the text. Models read this, so it stays readable:
    `not_signed_in: ... {"detail": ...}`.

    Codes and details are the REST error's for the same situation
    (`refusals`); a `Refusal` raised under a tool reaches the model as
    this, unchanged (`from_refusal`, applied in `_registry`).
    """

    def __init__(self, code: str, message: str, **details: Any) -> None:
        self.code = code
        self.message = message
        self.details = details
        rendered = f"{code}: {message}"
        if details:
            rendered += " " + json.dumps(details, ensure_ascii=False, default=str)
        super().__init__(rendered)

    @classmethod
    def from_refusal(cls, exc: Refusal) -> ToolError:
        return cls(exc.code, exc.message, **exc.details)


def not_signed_in() -> ToolError:
    return ToolError(
        "not_signed_in",
        "No F-list session. The user signs in inside the app "
        "window (F-list → Sign in); there is no sign-in tool on "
        "purpose, because credentials never travel through MCP.",
    )


def confirm_required(warning: str) -> ToolError:
    """The refusal of a call that needs `confirm=true`. `warning` says
    what the call would do to the user's work, in a sentence or two."""
    return ToolError(
        "confirm_required",
        f"{warning} Ask the user, then call again with confirm=true.",
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
        return archive_registry.character_dir(self.id)


def _registry_rows() -> list[tuple[str, str]]:
    """`(character_id, name)` for every registered character."""
    rows: list[tuple[str, str]] = []
    for cid, entry in archive_registry.load_registry().items():
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
    for row in archive_registry.list_archived_characters():
        name = str(row.get("name") or "")
        cid = str(row.get("id") or "")
        if name.lower() == needle.lower() or cid == needle:
            return ResolvedCharacter(id=cid, name=name or needle)

    known = sorted(
        {name for _, name in rows}
        | {
            str(r.get("name"))
            for r in archive_registry.list_archived_characters()
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
# Workbench or Live
# --------------------------------------------------------------------

#: What a `working_set` argument may name besides leaving it out.
WORKBENCH = "workbench"
SOURCES = (WORKBENCH, LIVE)


@dataclass(frozen=True)
class WorkbenchOrLive:
    """A character's Workbench, or its read-only Live."""

    character: ResolvedCharacter
    name: str
    is_live: bool = False


def workbench_target(character: ResolvedCharacter) -> WorkbenchOrLive:
    """The character's Workbench, under the one name a model sees."""
    return WorkbenchOrLive(character=character, name=archive_workbench.WORKBENCH_NAME)


def resolve_workbench_or_live(
    character: ResolvedCharacter,
    workbench_or_live: str | None,
    *,
    allow_live: bool = True,
    for_write: bool = False,
    param: str = "working_set",
) -> WorkbenchOrLive:
    """Resolve `working_set`: omitted (or `"workbench"`) is the
    character's Workbench, `"live"` is Live. Anything else is refused:
    a character has one Workbench, so there is nothing else to name.

    `for_write=True` refuses Live. `param` is the argument's name, for
    the error message.
    """
    needle = (
        "" if workbench_or_live is None else str(workbench_or_live).strip().lower()
    )

    if needle == LIVE:
        if not allow_live or for_write:
            raise ToolError(
                "live_is_read_only",
                "'live' is the last profile pulled from F-list and is "
                f"never edited. Leave {param} out to edit the "
                "Workbench instead.",
            )
        return WorkbenchOrLive(character=character, name=LIVE, is_live=True)

    if needle not in ("", WORKBENCH):
        raise ToolError(
            "validation_failed",
            f"{param}: got {str(workbench_or_live).strip()!r}, but "
            f"{character.name} has one Workbench beside its Live and "
            f"nothing else to name. Leave {param} out (or pass "
            "'workbench') for the Workbench, or pass 'live' for Live.",
            field=param,
            allowed=list(SOURCES),
        )

    # The Workbench, which is what the window shows. It is seeded from
    # Live the first time anything asks: for a read this is harmless,
    # and it spares every caller a "create one first" step the window
    # does not have either.
    if archive_workbench.read_workbench(character.id, create=True) is None:
        raise ToolError(
            "no_workbench",
            f"{character.name} has never been pulled from F-list, so "
            "there is nothing to copy into a Workbench. Pull the "
            "character first.",
        )
    return workbench_target(character)


def load_payload(target: WorkbenchOrLive) -> dict[str, Any]:
    """Read the payload behind a resolved Workbench or Live."""
    if target.is_live:
        live = archive_live.read_live(target.character.id)
        if live is None:
            raise ToolError(
                "no_live",
                f"No live profile stored for {target.character.name}. "
                "Run pull_character first.",
            )
        return live
    bench = archive_workbench.read_workbench(target.character.id)
    payload = bench.payload if bench is not None else None
    if payload is None:
        raise ToolError(
            "no_workbench",
            f"{target.character.name}'s Workbench has no payload on disk.",
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


def resolve_ingest_scope(character: str | None, partner: str | None) -> dict[str, str]:
    """An Index ingest scope with its names spelled the way the Logs
    spell them: one conversation, every conversation of one character,
    or `{}` for everything. The window's ingest and MCP `ingest_logs`
    both resolve here, so the Labels and alias links, keyed on the
    on-disk spelling, are found whichever case or alias was typed."""
    if partner and not character:
        raise ToolError(
            "validation_failed",
            "partner needs a character too — logs are scoped per (your "
            "character, their character) pair",
        )
    if character and partner:
        conv = resolve_conversation(character, partner)
        return {"character": conv.character, "partner": conv.partner}
    if character:
        return {"character": resolve_log_character(character)}
    return {}


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
