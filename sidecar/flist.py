"""F-list public profile fetch and parse.

F-list serves the raw BBCode source of a character's profile on the
public `/c/<name>` page, but only after the visitor accepts the
adult-content splash. The splash sets a `warning=1` cookie; sending
that cookie on the initial request short-circuits the splash and
returns the real profile HTML.

No login is required for any of this. The richer JSON endpoint at
`/json/api/character-data.php` does need a ticket, so we deliberately
stay on the HTML scrape path.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, asdict, field
from typing import Any
from urllib.parse import quote

import httpx

USER_AGENT = "flist-workbench/0.0.0 (+https://github.com/FoundryBlaise/flist-workbench)"
BASE = "https://www.f-list.net"

# F-list URL-encodes spaces in profile paths; lowercase is permitted but
# the rendered HTML preserves the canonical capitalisation.
_PROFILE_URL = BASE + "/c/{name}"


class ProfileNotFound(Exception):
    pass


@dataclass(slots=True)
class Profile:
    name: str
    avatar_url: str | None
    stats: dict[str, str] = field(default_factory=dict)
    bbcode: str = ""
    # Manifest for inline images referenced by [img=ID] tags. F-list
    # embeds this on the profile page so the client can map a numeric
    # id to its content-addressed CDN URL.
    inlines: dict[str, dict[str, Any]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


async def fetch_profile(name: str, *, client: httpx.AsyncClient | None = None) -> Profile:
    """Fetch and parse a public character profile by name."""
    own_client = client is None
    client = client or httpx.AsyncClient(timeout=15.0, follow_redirects=True)
    try:
        url = _PROFILE_URL.format(name=quote(name, safe=""))
        res = await client.get(
            url,
            headers={"User-Agent": USER_AGENT},
            cookies={"warning": "1"},
        )
        res.raise_for_status()
        return parse_profile(res.text, requested_name=name)
    finally:
        if own_client:
            await client.aclose()


_TITLE_RE = re.compile(r"<title>F-list - ([^<]+)</title>")
_SYSTEM_MSG_TITLE = "System message"
_AVATAR_RE = re.compile(
    r'<div class="Character_PageAvatar">\s*<img\s+src="([^"]+)"',
    re.IGNORECASE,
)
_STAT_RE = re.compile(
    r'<span class="taglabel">\s*([^<]+?)\s*</span>\s*:\s*([^<]+?)\s*<br',
    re.IGNORECASE,
)
_FORMATTED_BLOCK_RE = re.compile(
    r"<div class='FormattedBlock'[^>]*>(.*?)</div>",
    re.IGNORECASE | re.DOTALL,
)
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_INLINES_RE = re.compile(r"FList\.Inlines\.inlines\s*=\s*(\{.*?\})\s*;", re.DOTALL)


def parse_profile(profile_html: str, *, requested_name: str | None = None) -> Profile:
    title_match = _TITLE_RE.search(profile_html)
    title = title_match.group(1).strip() if title_match else ""
    if not title or title == _SYSTEM_MSG_TITLE:
        raise ProfileNotFound(requested_name or "<unknown>")

    avatar_match = _AVATAR_RE.search(profile_html)
    avatar_url = avatar_match.group(1) if avatar_match else None

    stats: dict[str, str] = {}
    for key, value in _STAT_RE.findall(profile_html):
        clean_key = html.unescape(key).strip()
        clean_value = html.unescape(value).strip()
        if clean_key and clean_value:
            stats[clean_key] = clean_value

    bbcode = ""
    block = _FORMATTED_BLOCK_RE.search(profile_html)
    if block:
        raw = block.group(1)
        # F-list inserts <br /> for source newlines. The newline is already
        # in the HTML; the <br /> is the display marker. Strip the markers
        # and keep the underlying whitespace.
        without_br = _BR_RE.sub("", raw)
        # F-list serves bare \r line breaks. Normalise to \n so editors
        # and CodeMirror don't choke. Python's text-mode file reading
        # already does this for the fixture, which is why this matters
        # only on the live HTTP path.
        normalised = without_br.replace("\r\n", "\n").replace("\r", "\n")
        bbcode = html.unescape(normalised).strip()

    inlines: dict[str, dict[str, Any]] = {}
    inlines_match = _INLINES_RE.search(profile_html)
    if inlines_match:
        try:
            inlines = json.loads(inlines_match.group(1))
        except json.JSONDecodeError:
            inlines = {}

    return Profile(
        name=title,
        avatar_url=avatar_url,
        stats=stats,
        bbcode=bbcode,
        inlines=inlines,
    )
