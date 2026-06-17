"""QA seed for the Backups sidebar list + Browse Backup verification.

Creates two characters:
  9001 — "Backup Test One":   has TWO real ZIP backups created via
         character_archive.save_zip_backup, so the embedded working.json
         path exists and Browse Backup should render fully.
  9002 — "Legacy Backup":     live + one synthetic legacy backup ZIP
         that contains ONLY character.json (no working.json). Should
         trigger the 410-style "predates Browse support" message.

Reads FLIST_WORKBENCH_DATA_DIR from env (Playwright sets it).
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecar"))

import character_archive  # noqa: E402
import paths as _paths  # noqa: E402


def _live(cid: int, name: str, desc: str) -> dict:
    return {
        "id": cid,
        "name": name,
        "description": desc,
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


def main() -> None:
    data_dir = Path(os.environ["FLIST_WORKBENCH_DATA_DIR"])
    _paths.user_data_dir = lambda: data_dir  # type: ignore[assignment]
    data_dir.mkdir(parents=True, exist_ok=True)

    # ---- Character 9001 with real backups ----
    cid1 = 9001
    character_archive.write_live(
        cid1,
        _live(cid1, "Backup Test One", "[b]Original description[/b]"),
    )
    first = character_archive.save_zip_backup(cid1, force=True)
    print("first backup:", first)
    # Mutate live so the second backup is actually different.
    time.sleep(1.2)
    character_archive.write_live(
        cid1,
        _live(cid1, "Backup Test One", "[b]Updated description, v2[/b]"),
    )
    second = character_archive.save_zip_backup(cid1, force=True)
    print("second backup:", second)
    backups_1 = character_archive.list_zip_backups(cid1)
    print(f"character 9001 has {len(backups_1)} backups")

    # ---- Character 9002 with one legacy ZIP (no working.json) ----
    cid2 = 9002
    character_archive.write_live(
        cid2,
        _live(cid2, "Legacy Backup", "Legacy only — pre-Browse era"),
    )
    # character_archive stores per-character data under name, not id.
    char_root = data_dir / "characters" / "Legacy Backup"
    backups_dir = char_root / "backups"
    backups_dir.mkdir(parents=True, exist_ok=True)
    legacy_zip = backups_dir / "2025-01-01T000000Z.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "character.json",
            json.dumps(
                {
                    "character": _live(
                        cid2,
                        "Legacy Backup",
                        "Legacy only — pre-Browse era",
                    )
                }
            ),
        )
        # no working.json — that's the whole point
    legacy_zip.write_bytes(buf.getvalue())
    print(f"wrote legacy backup at {legacy_zip}")

    backups_2 = character_archive.list_zip_backups(cid2)
    print(f"character 9002 has {len(backups_2)} backups")

    print(f"seed done at {data_dir}")


if __name__ == "__main__":
    main()
