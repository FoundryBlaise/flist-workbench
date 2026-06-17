"""Pre-seed an F-list Workbench archive with a synthetic character whose
standard kinks have been assigned to all four buckets, plus a mock
mapping-list cache so the sidecar can serve `/flist/mapping-list`
without needing F-list auth.

Used by tests/uxtest/kinks-mapping-recovery.spec.ts to verify that
KinksPane renders standard-kink rows in the bucket columns once
mapping is available. Without these on-disk fixtures the test would
need a live sign-in plus a real character with assigned standards.

Reads FLIST_WORKBENCH_DATA_DIR from env and populates:

    <datadir>/cache/mapping-list.json         minimal F-list mapping
    <datadir>/characters/9001/live.json       fake character
    <datadir>/characters/9001/working.json    same payload + assignments
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecar"))

import character_archive  # noqa: E402  (sys.path tweak required first)
import paths  # noqa: E402


CHARACTER_ID = "9001"
CHARACTER_NAME = "Test Kinks Character"

# A tiny but representative mapping. Each id matches a real F-list
# kink id so the keys line up with what working.json carries.
MAPPING_KINKS: list[dict[str, str]] = [
    {"id": "8", "name": "Dirty Talking", "description": "Speech.", "group_id": "1"},
    {"id": "148", "name": "Flexibility / Contortionism", "description": "Bendy.", "group_id": "1"},
    {"id": "250", "name": "Pet-Play (Submissive)", "description": "Sub.", "group_id": "2"},
    {"id": "259", "name": "Pet-Play (Dominant)", "description": "Dom.", "group_id": "2"},
    {"id": "284", "name": "Praise", "description": "Words.", "group_id": "1"},
    {"id": "300", "name": "Romance", "description": "Hearts.", "group_id": "3"},
    {"id": "531", "name": "Femboys", "description": "Effeminate.", "group_id": "1"},
    {"id": "579", "name": "Long Sessions", "description": "Time.", "group_id": "3"},
    {"id": "580", "name": "Open Communication", "description": "Talk.", "group_id": "3"},
    {"id": "581", "name": "Aftercare", "description": "Care.", "group_id": "3"},
]
MAPPING_GROUPS = [
    {"id": "1", "name": "Body / Behaviour"},
    {"id": "2", "name": "Power Dynamics"},
    {"id": "3", "name": "Style / Setting"},
]

# Working-copy assignments: spread across all four buckets so each
# bucket has at least one row. Keys must be bare numeric ids (no
# fetish_ prefix) — that's how zip_serialise + sidecar normalise.
WORKING_KINKS = {
    "8":   "fave",
    "148": "fave",
    "531": "fave",
    "250": "yes",
    "259": "yes",
    "284": "maybe",
    "300": "maybe",
    "579": "no",
    "580": "no",
    "581": "no",
}


def main() -> None:
    data_dir = Path(os.environ["FLIST_WORKBENCH_DATA_DIR"])
    # Force character_archive to resolve userdata to the test dir.
    paths.user_data_dir = lambda: data_dir  # type: ignore[assignment]
    data_dir.mkdir(parents=True, exist_ok=True)

    # 1. Mapping cache. fetch_mapping_list checks file mtime against a
    # 7-day TTL — a freshly-written file is well within TTL, so the
    # sidecar will serve from cache and never call F-list.
    cache_root = character_archive.cache_root()
    cache_root.mkdir(parents=True, exist_ok=True)
    mapping_payload = {
        "kinks": MAPPING_KINKS,
        "kink_groups": MAPPING_GROUPS,
        "infotags": [],
        "listitems": [],
    }
    (cache_root / "mapping-list.json").write_text(
        json.dumps(mapping_payload), encoding="utf-8"
    )

    # 2. Character + live.json. Minimal shape — kinks dict assigns the
    # full set so the picker renders bucket rows.
    live = {
        "id": CHARACTER_ID,
        "name": CHARACTER_NAME,
        "description": "Synthetic character for kink-bucket regression test.",
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
        "kinks": WORKING_KINKS,
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

    # 3. Working copy mirrors live + carries the same assignments. This
    # is what KinksPane reads via selectWorkingSlot.
    working = {
        "_schema_version": character_archive.WORKING_SCHEMA_VERSION,
        "_overlay": [],
        "character": {
            "id": CHARACTER_ID,
            "name": CHARACTER_NAME,
            "description": live["description"],
            "custom_title": "",
        },
        "settings": live["settings"],
        "infotags": {},
        "kinks": WORKING_KINKS,
        "custom_kinks": {},
        "inlines": {},
        "images": [],
        "_custom_kinks_order": [],
    }
    character_archive.write_working(CHARACTER_ID, working, expected_etag=None)

    print(
        f"seeded mapping ({len(MAPPING_KINKS)} kinks) + character "
        f"{CHARACTER_ID} with {len(WORKING_KINKS)} assignments at {data_dir}"
    )


if __name__ == "__main__":
    main()
