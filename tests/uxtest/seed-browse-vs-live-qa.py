"""QA seed for the Browse-vs-Live visual identity check.

Creates one character (id 9100, "Visual Identity Probe") whose live.json
carries enough content to exercise:

  * BBCode tags in description ([b], [i], [color], [url], [user], [icon],
    [eicon]) so the preview-pane chrome and theme colors show
  * Inline images ([inline] refs + matching files on disk)
  * Infotags (a handful of common fields)
  * Standard kinks across all four buckets
  * Custom kinks
  * Gallery images

Then triggers a real ZIP backup via character_archive.save_zip_backup
so the on-disk Backups list has one entry that Browse Backup can open.

Reads FLIST_WORKBENCH_DATA_DIR from env (Playwright sets it).
"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecar"))

import character_archive  # noqa: E402
import paths as _paths  # noqa: E402


CID = 9100
NAME = "Visual Identity Probe"

# Two inline images referenced from the description. CDN basenames are
# how F-list keys them; the inlines/ dir uses the same basename.
INLINE_IDS = ["aaaa1111", "bbbb2222"]

# Gallery images on disk.
GALLERY: list[tuple[str, tuple[int, int], tuple[int, int, int]]] = [
    ("20000001", (600, 800), (200, 90, 90)),
    ("20000002", (800, 600), (90, 140, 200)),
    ("20000003", (700, 700), (120, 180, 100)),
    ("20000004", (500, 800), (180, 140, 70)),
]


DESCRIPTION = (
    "[b]Visual Identity Probe[/b]\n"
    "\n"
    "This block exercises [color=red]color tags[/color], "
    "[i]italics[/i], and [u]underline[/u]. "
    "Links: [url=https://www.f-list.net/]F-list[/url].\n"
    "\n"
    "Inline images (must render, not appear as bracket literals):\n"
    "[eicon]happy[/eicon] [eicon]love[/eicon]\n"
    "\n"
    f"[inline]{INLINE_IDS[0]}[/inline]\n"
    "\n"
    "Second inline:\n"
    f"[inline]{INLINE_IDS[1]}[/inline]\n"
    "\n"
    "[hr]\n"
    "Footer section with [b][color=blue]bold blue[/color][/b] text."
)


INFOTAGS = {
    "1": "Male",            # gender (id varies; values are validated by mapping)
    "2": "Bi / curious",    # orientation
    "3": "Casual",          # language pref
    "29": "180cm",          # height
    "15": "Earth",          # species
}


KINKS = {
    "8":   "fave",
    "148": "yes",
    "284": "maybe",
    "579": "no",
}

CUSTOM_KINKS = {
    "custom-1": {
        "name": "Custom Probe Kink One",
        "description": "[b]Heavy emphasis[/b] on custom rendering.",
        "choice": "fave",
        "children": [],
    },
    "custom-2": {
        "name": "Custom Probe Kink Two",
        "description": "Plain text custom kink.",
        "choice": "yes",
        "children": [],
    },
}


def _png_bytes(size: tuple[int, int], rgb: tuple[int, int, int]) -> bytes:
    img = Image.new("RGB", size, rgb)
    w, h = size
    for x in range(w):
        img.putpixel((x, 0), (255, 255, 255))
        img.putpixel((x, h - 1), (255, 255, 255))
    for y in range(h):
        img.putpixel((0, y), (255, 255, 255))
        img.putpixel((w - 1, y), (255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def main() -> None:
    data_dir = Path(os.environ["FLIST_WORKBENCH_DATA_DIR"])
    _paths.user_data_dir = lambda: data_dir  # type: ignore[assignment]
    data_dir.mkdir(parents=True, exist_ok=True)

    # ---------- inline images on disk ----------
    inlines_dir = character_archive.inlines_dir(CID)
    inlines_dir.mkdir(parents=True, exist_ok=True)
    inline_meta: dict[str, dict] = {}
    for idx, basename in enumerate(INLINE_IDS):
        rgb = (220, 80, 80) if idx == 0 else (80, 140, 220)
        png = _png_bytes((400, 250), rgb)
        (inlines_dir / f"{basename}.png").write_bytes(png)
        inline_meta[basename] = {
            "name": basename,
            "extension": "png",
            "hash": basename,
            "nsfw": False,
        }

    # ---------- gallery on disk ----------
    live_images: list[dict] = []
    for idx, (image_id, size, rgb) in enumerate(GALLERY):
        png = _png_bytes(size, rgb)
        character_archive.write_character_image(CID, image_id, "png", png)
        live_images.append({
            "image_id": image_id,
            "extension": "png",
            "height": str(size[1]),
            "width": str(size[0]),
            "description": f"Gallery caption {idx + 1}" if idx % 2 == 0 else "",
            "sort_order": str(idx),
        })

    # ---------- live.json ----------
    live = {
        "id": CID,
        "name": NAME,
        "description": DESCRIPTION,
        "views": 0,
        "customs_first": True,
        "custom_title": "Probe Subject",
        "is_self": True,
        "settings": {
            "customs_first": True,
            "show_friends": False,
            "guestbook": True,
            "prevent_bookmarks": False,
            "public": True,
        },
        "badges": [],
        "created_at": 0,
        "updated_at": 0,
        "kinks": KINKS,
        "custom_kinks": CUSTOM_KINKS,
        "infotags": INFOTAGS,
        "inlines": inline_meta,
        "images": live_images,
        "character_list": [],
        "timezone": 0,
        "current_user": {"inline_mode": 0, "animated_icons": True},
        "error": "",
        "fetched_at": 1,
    }
    character_archive.write_live(CID, live)

    # ---------- mapping cache so kinks/infotags resolve ----------
    cache_root = character_archive.cache_root()
    cache_root.mkdir(parents=True, exist_ok=True)
    mapping_payload = {
        "kinks": [
            {"id": "8", "name": "Dirty Talking", "description": "Speech.", "group_id": "1"},
            {"id": "148", "name": "Flexibility / Contortionism", "description": "Bendy.", "group_id": "1"},
            {"id": "284", "name": "Praise", "description": "Words.", "group_id": "1"},
            {"id": "579", "name": "Long Sessions", "description": "Time.", "group_id": "3"},
        ],
        "kink_groups": [
            {"id": "1", "name": "Body / Behaviour"},
            {"id": "3", "name": "Style / Setting"},
        ],
        "infotags": [
            {"id": "1", "name": "Gender", "type": "list", "group_id": "1", "list": []},
            {"id": "2", "name": "Orientation", "type": "list", "group_id": "1", "list": []},
            {"id": "3", "name": "Language preference", "type": "text", "group_id": "1", "list": []},
            {"id": "29", "name": "Height", "type": "text", "group_id": "2", "list": []},
            {"id": "15", "name": "Species", "type": "text", "group_id": "2", "list": []},
        ],
        "infotag_groups": [
            {"id": "1", "name": "General"},
            {"id": "2", "name": "Physical"},
        ],
        "listitems": [],
    }
    (cache_root / "mapping-list.json").write_text(
        json.dumps(mapping_payload), encoding="utf-8"
    )

    # ---------- two ZIP backups so the swap smoke test has 2 rows ----------
    backup1 = character_archive.save_zip_backup(CID, force=True)
    import time as _time
    _time.sleep(1.2)
    # Mutate live so the second backup is content-distinct.
    live2 = dict(live)
    live2["description"] = DESCRIPTION + "\n\n[i]Second backup variant[/i]"
    character_archive.write_live(CID, live2)
    backup2 = character_archive.save_zip_backup(CID, force=True)
    print(f"seeded character {CID} ({NAME}) and backups {backup1['filename']} + {backup2['filename']}")

    # ---------- second character so char-switch smoke test has a target ----------
    cid2 = 9101
    name2 = "Second Probe"
    live_b = {
        "id": cid2,
        "name": name2,
        "description": "[b]Second probe[/b] — exists only to exercise character switching.",
        "views": 0,
        "customs_first": False,
        "custom_title": "",
        "is_self": True,
        "settings": {
            "customs_first": False,
            "show_friends": False,
            "guestbook": True,
            "prevent_bookmarks": False,
            "public": True,
        },
        "badges": [],
        "created_at": 0,
        "updated_at": 0,
        "kinks": {},
        "custom_kinks": {},
        "infotags": {},
        "inlines": {},
        "images": [],
        "character_list": [],
        "timezone": 0,
        "current_user": {"inline_mode": 0, "animated_icons": True},
        "error": "",
        "fetched_at": 1,
    }
    character_archive.write_live(cid2, live_b)
    print(f"seeded second character {cid2} ({name2})")


if __name__ == "__main__":
    main()
