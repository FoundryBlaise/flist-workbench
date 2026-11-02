"""Refusals: the errors a caller hears as `{code, message}`.

Every refusal the sidecar makes answers in that one shape, so the app
window, the extension and MCP tooling can show the reason without
special cases. Code that turns a request down raises a subclass of
`Refusal`; `server` registers one handler for the base class and
answers with the subclass's status, code and message.

A module of its own, like `archive_errors`: tests reload the modules
that raise these, and a class defined there would no longer match the
handler `server` registered for it.
"""

from __future__ import annotations


class Refusal(Exception):
    """A request the sidecar turns down.

    `status` and `code` belong to the class. The message is the text the
    error was raised with; a subclass that must not echo its input (an
    id or a name from the URL) sets `fixed_message` instead, and the
    caller hears that. `str(exc)` still carries the input for logs.
    """

    status: int = 400
    code: str = "refused"
    fixed_message: str | None = None

    @property
    def message(self) -> str:
        return self.fixed_message if self.fixed_message is not None else str(self)

    def body(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


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
        "log_dir_unavailable": 400,
    }

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
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


class NotStoppable(Refusal):
    """A stop asked of a sidecar that runs without the app's server loop
    (in tests, or a hand-started `uvicorn server:app`): there is nothing
    of ours to end, so it keeps running."""

    status = 409
    code = "not_stoppable"
    fixed_message = (
        "This sidecar was not started by F-list Workbench, so it cannot stop "
        "itself. Stop it where it was started."
    )
