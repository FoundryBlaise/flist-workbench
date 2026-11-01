"""Put one pulled character into an app data folder before the app starts.

    python seed_character.py <data_dir> <character_id> <name> <description>

Writes the character's Live through the sidecar's own archive writer,
as a Pull would, and its Workbench, plus a cached F-list mapping list
so the editor needs no network. The character is invented; nothing here is real profile
text.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def main() -> None:
    data_dir, character_id, name, description = sys.argv[1:5]
    # paths.user_data_dir() reads this on every call.
    os.environ["FLIST_WORKBENCH_DATA_DIR"] = data_dir
    sys.path.insert(0, str(REPO / "sidecar"))
    sys.path.insert(0, str(REPO / "sidecar" / "tests"))

    import character_archive  # noqa: E402
    from test_mcp_reads import MAPPING  # noqa: E402

    cache = character_archive.cache_root() / "mapping-list.json"
    cache.write_text(json.dumps(MAPPING), encoding="utf-8")
    character_archive.write_live(
        character_id,
        {
            "id": int(character_id),
            "name": name,
            "description": description,
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1,
        },
    )
    # Its Workbench too, as for a character the user has edited before.
    character_archive.resolve_workbench(character_id, create=True)


if __name__ == "__main__":
    main()
