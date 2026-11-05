"""What F-list's own parser will object to, checked before we store it.

The site parses BBCode in the browser — `FList.BBParser` in
`static.f-list.net/js/f-list.js` — and prepends a warning box to its
preview. Its warnings come in two classes, and a model writing a
description gets told about both here, in the same call that tried to
write it.

**Not allowed here.** "The [color] tag is not allowed here: …". The
rules are not guessable. Each tag declares what may nest inside it, as
True (anything), False (nothing) or a list. The catch is how that
compounds: F-list intersects the parent's list with the child's
`allowed`, and when the child's is the boolean True their loop
iterates over a boolean, produces nothing, and the empty result means
False. Inside [big] you therefore get exactly one level — whatever
sits in it may contain nothing further.

    [big][b]X[/b][/big]                        fine
    [big][color=cyan]X[/color][/big]           fine
    [big][b][color=cyan]X[/color][/b][/big]    not allowed
    [color=cyan][big][b]X[/b][/big][/color]    fine

**Not closed, or closed in the wrong order.** "Open [b] tag is not
properly closed (with [/b])." and "Bad BBCode in [b] tag, somewhere
around/after '…'." F-list takes the first closer after a tag's content
as that tag's closer. When it names another tag, or there is none, the
whole tag, with everything inside it, is printed as plain text — and
that climbs outwards, so one crossed pair deep inside a wrapper turns
the whole wrapper into raw code on the site. A naive open/close stack
gets this wrong (stray closers, cascades, which tag is blamed), so
`validate` ports F-list's algorithm instead, quirks included: a stray
extra closer gives no warning, and nothing inside a span F-list prints
literally is judged for "not allowed".

F-list emits the structural warnings while parsing, innermost first,
and the not-allowed ones while rendering, in source order; `validate`
returns them in that order.

Mirrored in `renderer/src/lib/bbcode/validate.ts` for the preview.
Both were checked case by case against the live parser on f-list.net;
`tests/test_bbcode_rules.py` and `validate.test.ts` read the verified
verdicts from one fixture,
`renderer/src/lib/bbcode/__fixtures__/flist_verified.json`, so the two
cannot drift apart unnoticed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal, Union

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

Kind = Literal["not-allowed", "not-closed", "bad-nesting"]

#: F-list's preprocessing pattern: anything bracketed. What is not
#: exactly `[name]`, `[name=…]` or `[/name]` with a known, lowercase
#: name is escaped to text before parsing. ([hr] is replaced before
#: that, so it never counts as a tag either.)
_BRACKETED = re.compile(r"(\[[\[ /]*)([^\[\]]+)([\] ]*\])")
# F-list's own pattern, case-insensitive and a prefix match. Both are
# reachable after the escape: a lone "[" it leaves alone pairs with the
# next tag's "]", so in "x [B [b]y" this reads "B [b" and opens a [b].
_OPENING = re.compile(r"^([a-z]+)(?:=([^\]]+))?", re.IGNORECASE)
# Escaped brackets keep their offsets, so warnings point into the
# source as written.
_ESC_OPEN, _ESC_CLOSE = "\x00", "\x01"


@dataclass(frozen=True)
class Warning_:
    tag: str
    start: int
    message: str
    kind: Kind


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


def _escape(source: str) -> str:
    """F-list's preprocessing, with same-length escapes."""

    def one(m: re.Match[str]) -> str:
        name = m.group(2).split("=", 1)[0]
        if m.group(1) in ("[", "[/") and m.group(3) == "]" and name in ALLOWED:
            return m.group(0)
        return m.group(0).replace("[", _ESC_OPEN).replace("]", _ESC_CLOSE)

    # F-list rescans from the end of each match, which is what sub does.
    return _BRACKETED.sub(one, source.replace("[]", _ESC_OPEN + _ESC_CLOSE))


@dataclass
class _Node:
    """A tag F-list keeps as a tag (`text` False) or prints literally."""

    tag: str
    start: int
    end: int
    text: bool = False
    content: list[_Node] = field(default_factory=list)


@dataclass
class _Open:
    """A tag whose content is being parsed: F-list's recursion, made
    an explicit stack so a long description cannot run out of it."""

    node: _Node | None  # None for the whole text
    openend: int  # the opening tag's `]`
    end: int  # end of the enclosing range
    n: int  # where the sibling scan goes on
    children: list[_Node] = field(default_factory=list)
    last_end: int = 0  # `end` of the last thing in the content
    done: bool = False


def _parse(a: str, source: str, warnings: list[Warning_]) -> list[_Node]:
    """F-list's `parse`. Records the structural warnings as it goes and
    returns the top-level nodes."""
    stack = [_Open(node=None, openend=-1, end=len(a), n=0)]
    while True:
        frame = stack[-1]
        if not frame.done:
            _scan(a, frame, stack)
            continue
        stack.pop()
        if frame.node is None:
            return frame.children
        node = _close(a, source, frame, warnings)
        parent = stack[-1]
        parent.children.append(node)
        parent.last_end = node.end
        if node.end < parent.end:
            parent.n = node.end
        else:
            parent.done = True


def _scan(a: str, frame: _Open, stack: list[_Open]) -> None:
    """One step of the sibling scan: find the next opening tag at or
    after `frame.n`, or end the content where F-list would."""
    n, end = frame.n, frame.end
    o = a.find("[", n, end)
    d = a.find("]", o, end) if o > -1 else -1
    m = _OPENING.search(a[o + 1:d]) if o > -1 and d > -1 else None
    name = m.group(1).lower() if m else ""
    if name not in ALLOWED:
        # A closer, or no tag left: the content ends here as text.
        frame.last_end = n
        frame.done = True
        return
    if name == "noparse":
        g = a.find("[/noparse]", d, end)
        g = g + 10 if g > -1 else end
        frame.children.append(_Node(tag="noparse", start=o, end=g))
        frame.last_end = g
        if g < end:
            frame.n = g
        else:
            frame.done = True
        return
    node = _Node(tag=name, start=o, end=end)
    stack.append(_Open(node=node, openend=d, end=end, n=d + 1, last_end=d + 1))


def _close(a: str, source: str, frame: _Open, warnings: list[Warning_]) -> _Node:
    """F-list's verdict on an open tag: the first `[/` after its
    content is its closer, or the whole tag becomes text."""
    node = frame.node
    assert node is not None
    name, end, h = node.tag, frame.end, frame.last_end
    v = a.find("[/", h, end)
    b = a.find("]", v, end) if v > -1 else -1
    node.content = frame.children
    if v > -1 and b > -1 and a[v + 2:b] == name:
        node.end = b + 1
        return node
    if a.find("[/" + name, h, end) == -1:
        kind: Kind = "not-closed"
        message = f"Open [{name}] tag is not properly closed (with [/{name}])."
    else:
        kind = "bad-nesting"
        after = source[frame.openend + 1:frame.openend + 51]
        message = f"Bad BBCode in [{name}] tag, somewhere around/after '{after}...'."
    warnings.append(Warning_(tag=name, start=node.start, message=message, kind=kind))
    node.text = True
    node.end = end if v == -1 or b == -1 else b + 1
    return node


def _not_allowed(source: str, tree: list[_Node], warnings: list[Warning_]) -> None:
    """F-list's rendering pass: every tag still a tag is checked
    against what its parent permits. A tag F-list prints literally is
    not looked into, and neither is one it refuses."""
    pending: list[tuple[_Node, Allowed]] = [(n, True) for n in reversed(tree)]
    while pending:
        node, outer = pending.pop()
        if node.text:
            continue
        if not _permits(outer, node.tag):
            warnings.append(
                Warning_(
                    tag=node.tag,
                    start=node.start,
                    message=(
                        f"The [{node.tag}] tag is not allowed here: "
                        f"{source[node.start:node.start + 60]}..."
                    ),
                    kind="not-allowed",
                )
            )
            continue
        inner = _new_allowed(outer, node.tag)
        pending.extend((c, inner) for c in reversed(node.content))


def validate(source: str) -> list[Warning_]:
    """Every warning F-list's parser would give, in F-list's order:
    the structural ones first, innermost first, then the not-allowed
    ones in source order. Empty means the site renders it as written."""
    warnings: list[Warning_] = []
    tree = _parse(_escape(source), source, warnings)
    _not_allowed(source, tree, warnings)
    return warnings


_NESTING_ADVICE = (
    "F-list allows only one level of nesting inside [big], "
    "[small], [sub] and [sup]: whatever sits directly inside them "
    "may not contain a further tag. Put the outer formatting "
    "outside instead — [color=cyan][big][b]Name[/b][/big][/color] "
    "rather than [big][b][color=cyan]Name[/color][/b][/big]. "
    "[url], [icon], [user], [eicon] and [img] take no tags at all."
)

_CLOSING_ADVICE = (
    "F-list takes the first closing tag after a tag's content as that "
    "tag's closer. When that is not the tag's own closer, or there is "
    "none, "
    "F-list shows the whole tag, with everything inside it, as plain "
    "text. Close every tag you open, and close tags in the reverse "
    "order you opened them: [color=green][b]x[/b][/color], not "
    "[color=green][b]x[/color][/b]."
)


def _line(w: Warning_) -> str:
    if w.kind == "not-closed":
        return (
            f"{w.message} It opens at character {w.start}; close it "
            f"with [/{w.tag}]."
        )
    if w.kind == "bad-nesting":
        return (
            f"{w.message} It opens at character {w.start}; close it "
            f"with [/{w.tag}], in reverse order of opening: the first "
            f"closing tag after its content must be its own."
        )
    return w.message


def explain(warnings: list[Warning_]) -> str:
    """One paragraph a model can act on without a second call."""
    if not warnings:
        return ""
    lines = [_line(w) for w in warnings[:5]]
    if len(warnings) > 5:
        lines.append(f"…and {len(warnings) - 5} more.")
    refused = any(w.kind == "not-allowed" for w in warnings)
    raw = any(w.kind != "not-allowed" for w in warnings)
    if refused and raw:
        verdict = (
            "F-list's own BBCode parser would refuse some of this text "
            "and show some of it as plain text"
        )
    elif raw:
        verdict = (
            "F-list would show part of this text as plain text, its "
            "BBCode printed raw"
        )
    else:
        verdict = "F-list's own BBCode parser would refuse this text"
    advice = [a for a, on in ((_CLOSING_ADVICE, raw), (_NESTING_ADVICE, refused)) if on]
    return (
        f"{verdict}, so it was not written:\n"
        + "\n".join(f"  - {line}" for line in lines)
        + "\n\n"
        + "\n\n".join(advice)
    )
