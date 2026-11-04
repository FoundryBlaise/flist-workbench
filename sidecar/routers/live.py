"""Live: the copy of a character as it was last pulled. Read-only."""

from typing import Any

from fastapi import APIRouter
from pydantic import RootModel

import archive_live
from archive_errors import NoLive

router = APIRouter()


class Live(RootModel[dict[str, Any]]):
    """A character's Live: F-list's character-data answer as the last
    Pull stored it, plus `fetched_at`. Free-form, because F-list may add
    fields and the window passes on what it does not know."""


@router.get("/flist/character/{character_id}/live")
def flist_character_live(character_id: str) -> Live:
    payload = archive_live.read_live(character_id)
    if payload is None:
        raise NoLive("no Live yet")
    return Live(payload)
