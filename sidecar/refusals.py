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
    id from the URL) fixes `message` on the class instead.
    """

    status: int = 400
    code: str = "refused"

    @property
    def message(self) -> str:
        return str(self)

    def body(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


class InvalidFileName(Refusal, ValueError):
    """A file name from a request that cannot name a file in its folder:
    a Backup, an image, a Log. Raised before any path is built from it."""

    code = "invalid_file_name"
