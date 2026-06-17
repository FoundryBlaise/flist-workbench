"""Pre-seed an F-list Workbench archive with two characters:

- "Sample Backed Up Char" with a single small backup ZIP (browsable).
- "Sample Empty Char" with zero backups (so the empty-state copy renders).

Used by the Backups-section UX review spec.
"""
from __future__ import annotations

import io
import os
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecar"))

import character_archive  # noqa: E402
import paths as _paths  # noqa: E402


def _make_live(character_id: str, name: str, with_image: bool) -> dict:
    images = []
    if with_image:
        img = Image.new("RGB", (400, 600), (110, 80, 140))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        character_archive.write_character_image(
            character_id, "20000001", "png", buf.getvalue()
        )
        images.append(
            {
                "image_id": "20000001",
                "extension": "png",
                "height": "600",
                "width": "400",
                "description": "Sample",
                "sort_order": "0",
            }
        )

    return {
        "id": character_id,
        "name": name,
        "description": (
            "[b]Sample character for the Backups UX review.[/b] "
            "This profile is intentionally short."
        ),
        "views": 0,
        "customs_first": False,
        "custom_title": "Test",
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
        "images": images,
        "character_list": [],
        "timezone": 0,
        "current_user": {"inline_mode": 0, "animated_icons": True},
        "error": "",
        "fetched_at": 1,
    }


def main() -> None:
    data_dir = Path(os.environ["FLIST_WORKBENCH_DATA_DIR"])
    _paths.user_data_dir = lambda: data_dir  # type: ignore[assignment]
    data_dir.mkdir(parents=True, exist_ok=True)

    # 1. Character with a backup.
    char_a = "8888"
    character_archive.register_character(char_a, "Sample Backed Up Char")
    character_archive.write_live(char_a, _make_live(char_a, "Sample Backed Up Char", True))
    result = character_archive.save_zip_backup(char_a, force=True)
    print(f"backup A: {result}")

    # 2. Character with no backups.
    char_b = "8889"
    character_archive.register_character(char_b, "Sample Empty Char")
    character_archive.write_live(char_b, _make_live(char_b, "Sample Empty Char", False))
    print("character B seeded without backups")


if __name__ == "__main__":
    main()
