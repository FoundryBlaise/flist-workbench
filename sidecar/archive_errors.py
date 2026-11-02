"""Errors the archive raises and the routes translate.

A module of its own so the class stays one class: tests reload
`character_archive`, and an exception defined there would no longer
match the handler `server` registered for it.
"""

from __future__ import annotations

from refusals import Refusal


class InvalidCharacterId(Refusal, ValueError):
    """An id that cannot name a folder inside the archive.

    Raised before any path is built from it, so nothing is read or
    created outside `characters/`. The caller hears a fixed message:
    the id itself is not echoed back.
    """

    code = "invalid_character_id"
    fixed_message = "invalid character_id"


class CharacterNotFound(Refusal, LookupError):
    """A safe id the archive holds no character for.

    Only a Pull brings a character into the archive (see
    `character_archive.create_character_dir`); everything else finds
    one, and an id it cannot find is this, not a fresh empty folder.
    The id is not echoed back.
    """

    status = 404
    code = "character_not_found"
    fixed_message = "no such character in the archive"


class WorkbenchNotKept(Refusal, OSError):
    """A whole-Workbench replacement (Restore, reset to Live) whose
    Backup of the Workbench it would replace could not be written. The
    Workbench is left as it was; the message says why the Backup
    failed."""

    status = 500
    code = "workbench_not_kept"


class NoLive(Refusal, LookupError):
    """An action that needs the character's Live, on a character never
    pulled."""

    status = 404
    code = "no_live"


class NoWorkbench(Refusal, LookupError):
    """A character with no Workbench, and none asked for or none that
    can be made: there is no Live to make it from."""

    status = 404
    code = "no_workbench"
    fixed_message = "this character has no Workbench yet"


class WorkbenchConflict(Refusal):
    """A Workbench write that has not seen what is on disk now: it sent
    no etag (`etag_required`) or a stale one (`etag_mismatch`). The body
    carries the current etag, so the caller can read again and decide."""

    status = 409

    def __init__(self, code: str, message: str, current_etag: str | None) -> None:
        super().__init__(message)
        self.code = code
        self.current_etag = current_etag

    def body(self) -> dict[str, str | None]:  # type: ignore[override]
        return {**super().body(), "current_etag": self.current_etag}


class InvalidWorkbenchPayload(Refusal, ValueError):
    """A payload that is not a Workbench: no touched-field overlay, or
    none of the profile's content keys."""

    status = 422
    code = "invalid_workbench_payload"
