"""Aliases: names of one partner linked into a group."""

from fastapi import APIRouter
from pydantic import BaseModel, Field

import aliases as aliases_store

router = APIRouter()


class AliasAdd(BaseModel):
    character: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    primary_name: str = Field(min_length=1, max_length=200)


@router.get("/aliases")
def aliases_list(char: str) -> dict:
    """Return {primary_name: [member names…]} for one character.

    Empty dict when the character has no linked partners. Renderer
    uses this to decide whether to render alias hints on each partner
    row.
    """
    conn = aliases_store.connect()
    try:
        groups = aliases_store.list_groups(conn, char)
    finally:
        conn.close()
    return {"character": char, "groups": groups}


@router.post("/aliases", status_code=201)
def aliases_add(body: AliasAdd) -> dict:
    """Link `name` to `primary_name` for `character`. Idempotent;
    handles chain consolidation (linking A→B then A→C ends with both
    A and B pointing at C, never building a multi-hop chain)."""
    conn = aliases_store.connect()
    try:
        aliases_store.add_alias(conn, body.character, body.name, body.primary_name)
        group = aliases_store.all_names_for(conn, body.character, body.primary_name)
    finally:
        conn.close()
    return {
        "character": body.character,
        "primary_name": body.primary_name,
        "group": group,
    }


@router.delete("/aliases")
def aliases_remove(char: str, name: str) -> dict:
    """Drop one name from its alias group."""
    conn = aliases_store.connect()
    try:
        removed = aliases_store.remove_alias(conn, char, name)
    finally:
        conn.close()
    return {"character": char, "name": name, "removed": removed}


@router.delete("/aliases/group")
def aliases_unlink_group(char: str, primary: str) -> dict:
    """Drop every member of an alias group at once."""
    conn = aliases_store.connect()
    try:
        deleted = aliases_store.unlink_group(conn, char, primary)
    finally:
        conn.close()
    return {"character": char, "primary": primary, "deleted": deleted}
