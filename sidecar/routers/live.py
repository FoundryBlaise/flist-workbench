"""Live: the copy of a character as it was last pulled. Read-only."""

from fastapi import APIRouter, HTTPException

import archive_live

router = APIRouter()


@router.get("/flist/character/{character_id}/live")
async def flist_character_live(character_id: str) -> dict:
    payload = archive_live.read_live(character_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="no Live yet")
    return payload
