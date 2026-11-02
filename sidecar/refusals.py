"""Refusals: the errors a caller hears as `{code, message, details}`.

Every error the sidecar answers has that one shape, so the app window,
the extension and MCP tooling can show the reason without special
cases: a `code` to switch on, a `message` to show, and a `details`
object with whatever else the situation carries (the etag on disk, the
field that was wrong), empty when there is nothing more to say. Code
that turns a request down raises a subclass of `Refusal`; `server`
registers one handler for the base class and answers with the
subclass's status and body, and an MCP tool reports the same code and
details (`workbench_mcp._registry`).

A code names one situation and answers with one status wherever it is
raised.

A module of its own, like `archive_errors`: tests reload the modules
that raise these, and a class defined there would no longer match the
handler `server` registered for it.
"""

from __future__ import annotations

from typing import Any


class Refusal(Exception):
    """A request the sidecar turns down.

    `status` and `code` belong to the class. The message is the text the
    error was raised with; a subclass that must not echo its input (an
    id or a name from the URL) sets `fixed_message` instead, and the
    caller hears that. `str(exc)` still carries the input for logs.
    `details` is what else the caller may need, as plain JSON values.
    """

    status: int = 400
    code: str = "refused"
    fixed_message: str | None = None

    def __init__(self, *args: object, details: dict[str, Any] | None = None) -> None:
        super().__init__(*args)
        self.details: dict[str, Any] = dict(details or {})

    @property
    def message(self) -> str:
        return self.fixed_message if self.fixed_message is not None else str(self)

    def body(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details}


class InvalidFileName(Refusal, ValueError):
    """A file name from a request that cannot name a file in its folder:
    a Backup, an image, a Log. Raised before any path is built from it."""

    code = "invalid_file_name"


class LogNameRefused(Refusal, LookupError):
    """A log character or partner name the Logs do not know (or cannot
    be read for). Carries the conversation resolver's own code, such as
    `log_character_not_found` or `partner_not_found`, so the window and
    MCP refuse an unknown name the same way."""

    code = "log_name_refused"

    #: The resolver's codes and the status each answers with. A code not
    #: listed here is a request the resolver could not act on: 400.
    STATUS_BY_CODE = {
        "log_character_not_found": 404,
        "partner_not_found": 404,
        "validation_failed": 400,
        "log_dir_unavailable": 503,
    }

    def __init__(self, message: str, *, code: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message, details=details)
        self.code = code
        self.status = self.STATUS_BY_CODE.get(code, 400)


class BackupNotUploadable(Refusal):
    """A Backup that must not be an Upload source: one taken without its
    image files would read as "remove every image". It still restores
    into the Workbench."""

    status = 409
    code = "backup_not_uploadable"


class BackupTooOld(Refusal):
    """A Backup an early version of the app took before it stored a
    loadable copy of the profile in the zip. Nothing in it can be loaded
    into the Workbench; it can still be downloaded."""

    status = 409
    code = "backup_too_old"
    fixed_message = (
        "This Backup comes from an early version of the app that did not "
        "yet store a loadable copy of the profile in it, so it cannot be "
        "loaded into the Workbench. Download it to look at what it holds."
    )


class BackupHoldsNoProfile(Refusal):
    """A Backup that holds no profile: the one the move to one Workbench
    made of the files an earlier version left behind (occasion
    `migration`, see `backup_origin.holds_profile`). It is never
    restored, browsed as a profile or uploaded, only downloaded."""

    status = 409
    code = "backup_holds_no_profile"
    fixed_message = (
        "This Backup keeps the older copies an earlier version of the app "
        "left behind before the upgrade, not a profile, so there is "
        "nothing in it to load or upload. Download it to look at them."
    )


class BackupNotFound(Refusal, LookupError):
    """A Backup name the character's backups folder holds no file for."""

    status = 404
    code = "backup_not_found"


class BackupUnreadable(Refusal, ValueError):
    """A Backup whose zip, or the profile stored in it, cannot be read."""

    status = 422
    code = "backup_unreadable"


class BackupNotWritten(Refusal):
    """A Backup that could not be packed: a file it needed went away
    while it was being built. Nothing was written; try again."""

    status = 409
    code = "backup_not_written"


class NotTrashed(Refusal, OSError):
    """Something that could not be moved to the Trash; it is still where
    it was."""

    status = 500
    code = "not_trashed"


class ImageNotFound(Refusal, LookupError):
    """An image (gallery, Pool, inline or in the Trash) that is not there."""

    status = 404
    code = "image_not_found"


class NoAvatar(Refusal, LookupError):
    """A character with no avatar on F-list, or one that could not be
    fetched: the window shows its initial instead."""

    status = 404
    code = "no_avatar"


class ProfileNotCached(Refusal, LookupError):
    """A Foreign profile asked about before it was ever opened."""

    status = 404
    code = "profile_not_cached"


class JobNotFound(Refusal, LookupError):
    """A job id the sidecar does not know (or no longer remembers)."""

    status = 404
    code = "job_not_found"


class NoIndex(Refusal):
    """The Index is empty: nothing has been ingested yet."""

    status = 409
    code = "no_index"


class UnsupportedType(Refusal, ValueError):
    """Bytes of a kind the route does not take (an image that is not
    PNG, JPEG or GIF; a render that is not PNG or JPEG)."""

    status = 415
    code = "unsupported_type"


class TooLarge(Refusal, ValueError):
    """A body over the size the route accepts."""

    status = 413
    code = "too_large"


class NotPaired(Refusal):
    """A browser-extension request without a valid pairing token."""

    status = 401
    code = "not_paired"
    fixed_message = "This browser extension is not paired with Workbench. Pair it in Settings."


class ValidationFailed(Refusal, ValueError):
    """A value the sidecar will not take. `details` names the field, the
    reason and, where there is a fixed set, the allowed values; MCP
    tools report the same (`workbench_mcp._context.validation_failed`)."""

    code = "validation_failed"

    def __init__(self, field: str, reason: str, *, allowed: Any = None) -> None:
        details: dict[str, Any] = {"field": field, "reason": reason}
        if allowed is not None:
            details["allowed"] = allowed
        super().__init__(f"{field}: {reason}", details=details)


class InvalidRequest(Refusal, ValueError):
    """A request missing something it must carry, said the way the
    sidecar answers a request it could not bind at all: 422
    `invalid_request` with the errors in `details.errors`."""

    status = 422
    code = "invalid_request"

    def __init__(self, loc: tuple[str, ...], msg: str) -> None:
        super().__init__(
            f"{'.'.join(loc)}: {msg}",
            details={"errors": [{"loc": list(loc), "msg": msg, "type": "value_error"}]},
        )


class FlistRefused(Refusal):
    """F-list, or the session to it, could not answer. The code says
    why, and each answers with its own status wherever it is raised:
    the Foreign viewer, a Pull, a look-up or the mapping list
    (`flist_api.refusal` turns the client's errors into these)."""

    code = "flist_error"
    status = 502

    STATUS_BY_CODE = {
        "not_signed_in": 401,
        "sign_in_failed": 401,
        "not_found": 404,
        "rate_limited": 429,
        "flist_error": 502,
    }

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message, details=details)
        self.code = code
        self.status = self.STATUS_BY_CODE.get(code, 502)
