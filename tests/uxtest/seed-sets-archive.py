"""Pre-seed an F-list Workbench v6 archive with multiple working sets,
snapshots, and backups so the Tier 7 sidebar screenshot harness has
realistic data to show.

Reads FLIST_WORKBENCH_DATA_DIR from env (set by the test runner) and
populates `<datadir>/characters/9998/`:

    live.json
    images/<image_id>.png            8 small synthetic PNGs
    sets/<set_id>/payload.json       3 sets, one per variant
    sets/<set_id>/meta.json
    sets/<set_id>/snapshots/<id>.json  2 snapshots per set
    active_set.json
    backups/                          4 backup ZIPs (1 auto, 2 set, 1 snapshot)
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import uuid
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecar"))

import character_archive  # noqa: E402


CHARACTER_ID = "9998"
CHARACTER_NAME = "Lady Amber Rotas"


SETS_TO_SEED = [
    {
        "name": "Main",
        "description": (
            "[b]Lady Amber Rotas[/b] · the canonical profile.\n"
            "Coastal merchant turned reluctant diplomat. Reads three "
            "treaties before breakfast and trusts none of them."
        )
    },
    {
        "name": "Modern AU",
        "description": (
            "[b]Amber Rotas[/b] · modern AU branch.\n"
            "Logistics manager at a shipping co-op. Same temperament, "
            "fewer swords, more spreadsheets."
        )
    },
    {
        "name": "Sub variant",
        "description": (
            "[b]Lady Amber Rotas[/b] · alternate dynamic.\n"
            "Public composure intact; the private side of her courtroom "
            "manner is the experiment here."
        )
    }
]


SNAPSHOTS_PER_SET = [
    ("Pre-rewrite", -3 * 86400),
    ("After kinks pass", -1 * 86400),
]


IMAGES = [
    ("20000001", (520, 800), (160, 80, 100)),
    ("20000002", (480, 720), (110, 130, 170)),
    ("20000003", (600, 900), (180, 140, 80)),
    ("20000004", (560, 760), (90, 150, 120)),
    ("20000005", (640, 780), (70, 100, 150)),
    ("20000006", (520, 720), (200, 130, 90)),
    ("20000007", (600, 720), (130, 90, 160)),
    ("20000008", (560, 800), (170, 90, 110)),
]


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _build_payload(description: str, image_count: int) -> dict:
    return {
        "_schema_version": 6,
        "_overlay": ["character.description"],
        "character": {
            "id": CHARACTER_ID,
            "name": CHARACTER_NAME,
            "description": description,
            "title": "Diplomat by trade",
        },
        "infotags": {
            "1": "Female",
            "3": "30",
            "9": "Cisgender Female",
        },
        "kinks": {},
        "custom_kinks": {},
        "images": [
            {
                "image_id": image_id,
                "extension": "png",
                "description": f"Sample {i + 1}",
                "sort_order": str(i)
            }
            for i, (image_id, _, _) in enumerate(IMAGES[:image_count])
        ],
        "inlines": {}
    }


def _build_live() -> dict:
    return {
        "id": CHARACTER_ID,
        "name": CHARACTER_NAME,
        "description": (
            "[b]Lady Amber Rotas[/b]\nCoastal merchant turned reluctant "
            "diplomat. Reads three treaties before breakfast and trusts "
            "none of them.\n[i]Last pulled from F-list moments ago.[/i]"
        ),
        "views": 412,
        "customs_first": False,
        "custom_title": "Diplomat by trade",
        "is_self": True,
        "settings": {
            "customs_first": False,
            "show_friends": True,
            "guestbook": True,
            "prevent_bookmarks": False,
            "public": True,
        },
        "badges": [],
        "created_at": int(time.time()) - 86400 * 90,
        "updated_at": int(time.time()) - 600,
        "kinks": {},
        "custom_kinks": {},
        "infotags": {
            "1": "Female",
            "3": "30",
            "9": "Cisgender Female",
        },
        "inlines": {},
        "images": [
            {
                "image_id": image_id,
                "extension": "png",
                "height": str(h),
                "width": str(w),
                "description": f"Sample {i + 1}",
                "sort_order": str(i),
            }
            for i, (image_id, (w, h), _) in enumerate(IMAGES)
        ],
        "character_list": [],
        "timezone": 0,
        "current_user": {"inline_mode": 0, "animated_icons": True},
        "error": "",
        "fetched_at": int(time.time()) - 600,
    }


def _write_image_bytes(image_id: str, size: tuple[int, int], rgb: tuple[int, int, int]) -> None:
    img = Image.new("RGB", size, rgb)
    for x in range(size[0]):
        img.putpixel((x, 0), (255, 255, 255))
        img.putpixel((x, size[1] - 1), (255, 255, 255))
    for y in range(size[1]):
        img.putpixel((0, y), (255, 255, 255))
        img.putpixel((size[0] - 1, y), (255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    character_archive.write_character_image(CHARACTER_ID, image_id, "png", buf.getvalue())


def main() -> None:
    data_dir = Path(os.environ["FLIST_WORKBENCH_DATA_DIR"])
    import documents as _docs

    _docs.user_data_dir = lambda: data_dir  # type: ignore[assignment]
    data_dir.mkdir(parents=True, exist_ok=True)

    for image_id, size, rgb in IMAGES:
        _write_image_bytes(image_id, size, rgb)

    character_archive.write_live(CHARACTER_ID, _build_live())

    char_dir = data_dir / "characters" / CHARACTER_ID
    sets_dir = char_dir / "sets"
    sets_dir.mkdir(parents=True, exist_ok=True)

    now = int(time.time())
    seeded_sets: list[dict] = []
    for idx, spec in enumerate(SETS_TO_SEED):
        set_id = _new_id()
        set_dir = sets_dir / set_id
        (set_dir / "snapshots").mkdir(parents=True, exist_ok=True)
        payload = _build_payload(spec["description"], image_count=len(IMAGES) - idx)
        (set_dir / "payload.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
        created = now - (3 - idx) * 86400 - idx * 600
        updated = now - idx * 600
        snapshots = []
        for snap_name, offset in SNAPSHOTS_PER_SET:
            snap_id = _new_id()
            snap_created = created + abs(offset) // 2 + len(snapshots)
            snap_payload = _build_payload(
                spec["description"] + f"\n[i]Snapshot: {snap_name}[/i]",
                image_count=len(IMAGES) - idx
            )
            (set_dir / "snapshots" / f"{snap_id}.json").write_text(
                json.dumps(
                    {
                        "id": snap_id,
                        "name": snap_name,
                        "createdAt": snap_created,
                        "payload": snap_payload,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            snapshots.append({"id": snap_id, "name": snap_name, "createdAt": snap_created})
        meta = {
            "id": set_id,
            "name": spec["name"],
            "createdAt": created,
            "updatedAt": updated,
            "snapshots": snapshots,
        }
        (set_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        seeded_sets.append(meta)

    active_set_id = seeded_sets[0]["id"]
    (char_dir / "active_set.json").write_text(
        json.dumps({"active_set_id": active_set_id}, indent=2), encoding="utf-8"
    )

    backups_dir = char_dir / "backups"
    backups_dir.mkdir(parents=True, exist_ok=True)

    # Compose three backup ZIPs via the v6 helper if available; fall
    # back to placeholder bytes so the UI at least renders rows.
    try:
        backup_specs = [
            ("auto-pull", None, None),
            ("manual-set", seeded_sets[0]["id"], None),
            ("manual-set", seeded_sets[1]["id"], None),
            ("manual-snapshot", seeded_sets[0]["id"], seeded_sets[0]["snapshots"][0]["id"]),
        ]
        for source, set_id, snap_id in backup_specs:
            if source == "auto-pull":
                payload = _build_live()
                name = None
            elif source == "manual-set":
                payload = _build_payload(
                    next(s for s in SETS_TO_SEED if s["name"] == [
                        m["name"] for m in seeded_sets if m["id"] == set_id
                    ][0])["description"],
                    image_count=8,
                )
                name = [m["name"] for m in seeded_sets if m["id"] == set_id][0]
            else:
                payload = _build_payload("Pre-rewrite snapshot body", image_count=8)
                name = "Pre-rewrite"
            character_archive.create_backup_from_payload(  # type: ignore[attr-defined]
                CHARACTER_ID,
                payload=payload,
                source=source,
                source_name=name,
            )
    except AttributeError:
        # v6 helper not yet built — drop placeholder ZIPs so the
        # legacy listing path renders.
        for idx in range(4):
            (backups_dir / f"placeholder_{idx}.zip").write_bytes(b"PK\x05\x06" + b"\x00" * 18)

    print(
        f"seeded {len(seeded_sets)} sets × {len(SNAPSHOTS_PER_SET)} snapshots + backups "
        f"at {char_dir}/"
    )


if __name__ == "__main__":
    main()
