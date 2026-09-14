"""What F-list's own parser will refuse, checked before we store it.

The site parses BBCode in the browser — `FList.TagParser` in
`static.f-list.net/js/f-list.js` — and prepends a warning box to its
preview: "The [color] tag is not allowed here: …". A profile that
trips it cannot be uploaded, and the user finds out at the worst
moment: after leaving the app, with the text already pasted into
F-list's form.

So a model writing a description gets told here instead, in the same
call that tried to write it.

The rules are not guessable. Each tag declares what may nest inside
it, as True (anything), False (nothing) or a list. The catch is how
that compounds: F-list intersects the parent's list with the child's
`allowed`, and when the child's is the boolean True their loop
iterates over a boolean, produces nothing, and the empty result means
False. Inside [big] you therefore get exactly one level — whatever
sits in it may contain nothing further.

    [big][b]X[/b][/big]                        fine
    [big][color=cyan]X[/color][/big]           fine
    [big][b][color=cyan]X[/color][/b][/big]    refused
    [color=cyan][big][b]X[/b][/big][/color]    fine

Mirrored in `renderer/src/lib/bbcode/validate.ts` for the preview.
Both were checked case by case against the live parser on f-list.net;
`tests/test_bbcode_rules.py` and `validate.test.ts` carry the same
cases so the two cannot drift apart unnoticed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Union

Allowed = Union[bool, tuple[str, ...]]

#: F-list's tag table. Tags it does not know are left alone by its
#: parser — rendered literally, no warning — so they are absent here.
ALLOWED: dict[str, Allowed] = {
    "b": True,
    "i": True,
    "u": True,
    "s": True,
    "color": True,
    "quote": True,
    "center": True,
    "left": True,
    "right": True,
    "justify": True,
    "indent": True,
    "heading": True,
    "collapse": True,
    "spoiler": True,
    "noparse": False,
    "url": False,
    "user": False,
    "icon": False,
    "eicon": False,
    "img": False,
    "sub": ("b", "i", "u"),
    "sup": ("b", "i", "u"),
    "big": ("url", "i", "u", "b", "color", "s"),
    "small": ("url", "i", "u", "b", "color", "s"),
}

_SELF_CLOSING = {"hr", "br"}
_TAG = re.compile(r"\[(/?)([a-zA-Z][a-zA-Z0-9]*)(?:=([^\]]*))?\]")


@dataclass(frozen=True)
class Warning_:
    tag: str
    start: int
    message: str


def _new_allowed(outer: Allowed, tag: str) -> Allowed:
    """F-list's `newAllowed`, boolean-versus-list quirk included.
    Fixing the quirk would make us disagree with the site, which is the
    one thing this must not do."""
    inner = ALLOWED.get(tag)
    if inner is None:
        return outer
    if outer is True and inner is True:
        return True
    if outer is False:
        return False
    if isinstance(inner, bool):
        # Their loop walks a boolean and finds nothing; empty is False.
        return inner if outer is True else False
    keep = tuple(
        name for name in inner if outer is True or name in outer
    )
    return keep or False


def _permits(outer: Allowed, tag: str) -> bool:
    if outer is True:
        return True
    if outer is False:
        return False
    return tag in outer


def validate(source: str) -> list[Warning_]:
    """Every tag F-list would reject, in source order. Empty means the
    site will take it."""
    warnings: list[Warning_] = []
    stack: list[tuple[str, Allowed]] = []
    allowed: Allowed = True
    in_noparse = False

    for m in _TAG.finditer(source):
        closing = m.group(1) == "/"
        name = m.group(2).lower()
        start = m.start()

        if in_noparse:
            if closing and name == "noparse":
                in_noparse = False
            continue

        if closing:
            for i in range(len(stack) - 1, -1, -1):
                if stack[i][0] == name:
                    allowed = stack[i][1]
                    del stack[i:]
                    break
            continue

        if name in ALLOWED and not _permits(allowed, name):
            warnings.append(
                Warning_(
                    tag=name,
                    start=start,
                    message=(
                        f"The [{name}] tag is not allowed here: "
                        f"{source[start:start + 60]}..."
                    ),
                )
            )
            # F-list renders the offending tag as literal text and
            # carries on with the same restriction in force.
            continue

        if name in _SELF_CLOSING:
            continue
        if name == "noparse":
            in_noparse = True
            continue
        stack.append((name, allowed))
        allowed = _new_allowed(allowed, name)

    return warnings


def explain(warnings: list[Warning_]) -> str:
    """One paragraph a model can act on without a second call."""
    if not warnings:
        return ""
    lines = [w.message for w in warnings[:5]]
    if len(warnings) > 5:
        lines.append(f"…and {len(warnings) - 5} more.")
    return (
        "F-list's own BBCode parser would refuse this text, so it was "
        "not written:\n"
        + "\n".join(f"  - {line}" for line in lines)
        + "\n\nF-list allows only one level of nesting inside [big], "
        "[small], [sub] and [sup]: whatever sits directly inside them "
        "may not contain a further tag. Put the outer formatting "
        "outside instead — [color=cyan][big][b]Name[/b][/big][/color] "
        "rather than [big][b][color=cyan]Name[/color][/b][/big]. "
        "[url], [icon], [user], [eicon] and [img] take no tags at all."
    )
