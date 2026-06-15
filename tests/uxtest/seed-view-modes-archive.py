"""Pre-seed a character archive + working copy + eicon catalog for the
view-modes screenshot harness. Reads FLIST_WORKBENCH_DATA_DIR from env."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecar"))

import character_archive  # noqa: E402

CHARACTER_ID = 9999
CHARACTER_NAME = "Test Sample Character"

SAMPLE_DESCRIPTION = (
    "[b]Live preview demo[/b]\n"
    "\n"
    "Try the Split / Code / Preview buttons in the toolbar above to "
    "switch how this pane and the right preview share space.\n"
    "\n"
    "[i]Click the [eicon] button to open the picker — it queries every "
    "eicon in the Xariah catalog via the sidecar.[/i]\n"
    "\n"
    "[eicon]happy[/eicon] [eicon]love[/eicon] [eicon]wave[/eicon]"
)


def main() -> None:
    data_dir = Path(os.environ["FLIST_WORKBENCH_DATA_DIR"])
    import documents as _docs

    _docs.user_data_dir = lambda: data_dir  # type: ignore[assignment]
    data_dir.mkdir(parents=True, exist_ok=True)

    # ---- Live snapshot + working copy ----
    live = {
        "id": CHARACTER_ID,
        "name": CHARACTER_NAME,
        "description": SAMPLE_DESCRIPTION,
        "views": 0,
        "customs_first": False,
        "custom_title": "Sample Character",
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
    character_archive.write_live(CHARACTER_ID, live)

    # ---- Eicon catalog cache (so the sidecar doesn't try to fetch
    # xariah.net during the test). A handful of well-known eicon names
    # is enough to populate the popover grid.
    eicon_names = [
        "happy", "happy2", "happy3", "happyface",
        "love", "love2", "loveit", "lovely",
        "wave", "waving", "wavehello",
        "smile", "smiling", "smug", "blush", "wink",
        "laugh", "lol", "rofl",
        "heart", "heart2", "heartred", "hearts",
        "yes", "no", "ok", "okay",
        "cat", "catlove", "catwave", "catears",
        "fox", "foxy", "wolf", "dog", "dogface",
        "coffee", "tea", "drink", "food", "pizza",
    ]
    cache = {
        "version": 2,
        "asOfTimestamp": 1700000000,
        "records": eicon_names,
    }
    (data_dir / "eicons.json").write_text(json.dumps(cache), encoding="utf-8")

    print(
        f"seeded archive + eicon cache at {data_dir} "
        f"({len(eicon_names)} eicons)"
    )


if __name__ == "__main__":
    main()
