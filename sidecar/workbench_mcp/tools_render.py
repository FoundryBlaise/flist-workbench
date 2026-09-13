"""Look at the profile, instead of reading its markup.

A model writing a description is working blind: BBCode is not a format
anyone parses accurately in their head. A `[collapse]` left open
swallows the rest of the page, a colour tag closed with the wrong name
bleeds, an `[img]` id that no longer resolves leaves a hole — and none
of that shows up when you re-read the source you just wrote. One look
at the rendered page settles all of it.

The picture comes from the app's own preview: same BBCode renderer,
same stylesheet, same F-list theme mimics. So what the model sees is
what the user sees, and the two cannot drift apart.

Requires the Workbench window to be open — it is the thing that can
draw. The tool says so plainly when it is closed rather than making
the caller wait out a timeout.
"""

from __future__ import annotations

import asyncio
from typing import Any

from mcp.server.fastmcp.utilities.types import Image

from services import render as render_service

from ._context import ToolError, audit, load_payload, resolve_character, resolve_set
from ._registry import TAG_CHARACTER, tool

THEMES = ("dark", "default", "light")

MIN_WIDTH = 320
MAX_WIDTH = 1600
DEFAULT_WIDTH = 900


@tool(
    tags=TAG_CHARACTER,
    title="See the profile as a picture",
    read_only=True,
    structured_output=False,
)
async def render_profile_image(
    character: str,
    working_set: str | None = None,
    theme: str = "dark",
    width: int = DEFAULT_WIDTH,
) -> Image:
    """Render a profile description and return it as a PNG.

    Use it after writing or editing a description, to check the result
    the way a person would: does the layout hold, did a tag leak, do
    the images load, is the colour readable on that theme. Reading the
    BBCode back does not answer any of those.

    `theme` mimics F-list's own three (dark, default, light) — worth
    trying more than one when a description sets colours, because a
    shade that reads well on dark can vanish on light. Pass
    working_set="live" to see what is published right now instead of
    the Workbench.

    The Workbench window has to be open: it holds the renderer that
    draws this.
    """
    if theme not in THEMES:
        raise ToolError(
            "invalid_theme",
            f"theme must be one of {', '.join(THEMES)}; got {theme!r}",
        )
    px = max(MIN_WIDTH, min(MAX_WIDTH, int(width)))

    target = resolve_character(character)
    resolved = resolve_set(target, working_set)
    payload = load_payload(resolved)
    char = payload.get("character") if isinstance(payload.get("character"), dict) else {}
    bbcode = (char or {}).get("description") or ""
    if not bbcode.strip():
        raise ToolError(
            "empty_description",
            f"{target.name}'s {resolved.name} description is empty — "
            "there is nothing to draw.",
        )
    inlines = payload.get("inlines")
    if not isinstance(inlines, dict):
        inlines = {}

    if not render_service.window_attached():
        raise ToolError(
            "window_not_running",
            "Rendering needs the Workbench window, and it is not open. "
            "Ask the user to start it, then try again.",
        )

    try:
        png, mime = await render_service.request(
            bbcode=bbcode,
            inlines=inlines,
            theme=theme,
            width=px,
            label=f"{target.name} / {resolved.name}",
        )
    except (TimeoutError, asyncio.TimeoutError) as exc:
        raise ToolError(
            "render_timed_out",
            "The window did not finish drawing in time. A very long "
            "description or a slow image host can do that; try a "
            "narrower width, or check the window is responding.",
        ) from exc
    except RuntimeError as exc:
        raise ToolError("render_failed", str(exc)) from exc

    audit(
        "render_profile_image",
        character=target.name,
        set=resolved.name,
        theme=theme,
        width=px,
        bytes=len(png),
        mime=mime,
    )
    # JPEG when the window had to compress a picture-heavy profile to
    # keep the tool result inside what a client will carry.
    return Image(data=png, format="jpeg" if mime == "image/jpeg" else "png")
