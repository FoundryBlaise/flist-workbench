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
    message = "invalid character_id"  # type: ignore[assignment]


class CharacterNotFound(Refusal, LookupError):
    """A safe id the archive holds no character for.

    Only a Pull brings a character into the archive (see
    `character_archive.create_character_dir`); everything else finds
    one, and an id it cannot find is this, not a fresh empty folder.
    The id is not echoed back.
    """

    status = 404
    code = "character_not_found"
    message = "no such character in the archive"  # type: ignore[assignment]
