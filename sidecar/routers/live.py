"""Live: the copy of a character as it was last pulled. Read-only."""

from fastapi import APIRouter

import character_archive
from archive_errors import NoLive

router = APIRouter()


@router.get("/flist/character/{character_id}/live")
async def flist_character_live(character_id: str) -> dict:
    payload = character_archive.read_live(character_id)
    if payload is None:
        raise NoLive("no Live yet")
    return payload
