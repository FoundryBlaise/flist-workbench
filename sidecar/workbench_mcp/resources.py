"""MCP resources (design §3.12).

Resources are for clients that browse them — Claude Desktop shows them
as attachable context. LM Studio, the primary client, does not, so
every one of these has a tool twin and nothing here is load-bearing.
Kept small for that reason: the tools are where the work happens.
"""

from __future__ import annotations

import json

from ._registry import TAG_CHARACTER, TAG_CORE, resource


@resource(
    "workbench://characters",
    tags=(TAG_CORE, TAG_CHARACTER),
    name="Characters",
    description="Every character with a local archive. Tool twin: list_characters.",
    mime_type="application/json",
)
def characters_resource() -> str:
    from .tools_sets import list_characters

    return json.dumps(list_characters(), indent=2, default=str)


@resource(
    "workbench://bbcode-reference",
    tags=(TAG_CORE, TAG_CHARACTER),
    name="F-list BBCode",
    description=(
        "The markup a profile description uses. Tool twin: "
        "get_bbcode_reference."
    ),
    mime_type="application/json",
)
def bbcode_resource() -> str:
    from .tools_sets import get_bbcode_reference

    return json.dumps(get_bbcode_reference(), indent=2)


@resource(
    "workbench://character/{name}/description",
    tags=TAG_CHARACTER,
    name="A character's description",
    description=(
        "The active working set's description, in BBCode. Tool twin: "
        "get_description, which can also page through a long one."
    ),
    mime_type="text/plain",
)
def description_resource(name: str) -> str:
    from .tools_sets import get_description

    return get_description(character=name)["description"]
