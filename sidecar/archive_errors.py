"""Errors the archive raises and the routes translate.

A module of its own so the class stays one class: tests reload
`character_archive`, and an exception defined there would no longer
match the handler `server` registered for it.
"""

from __future__ import annotations


class InvalidCharacterId(ValueError):
    """An id that cannot name a folder inside the archive.

    Raised before any path is built from it, so nothing is read or
    created outside `characters/`.
    """
