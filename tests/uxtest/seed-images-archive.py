"""Pre-seed an F-list Workbench archive with a synthetic character + a
heap of varied-aspect images. Used by the Images-tab Playwright test so
the gallery preview pane renders multi-row tile heap exactly as the
real F-list profile page would.

Reads FLIST_WORKBENCH_DATA_DIR from env (set by the test runner) and
populates `<datadir>/characters/9999/`:

    live.json                 fake character with 24 image entries
    images/<image_id>.<ext>   24 synthetic PNGs, varied aspect ratios

Each image is a flat color block — varied aspect ratios (portrait,
landscape, square) so the tile-heap demonstrates the wrap behaviour.
"""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

from PIL import Image

# Sidecar lives next to tests/.
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecar"))

import character_archive  # noqa: E402  (sys.path tweak required first)


CHARACTER_ID = "9999"
CHARACTER_NAME = "Test Sample Character"

# (image_id, (width, height), (R,G,B)) — 24 entries with varied ratios
# so the gallery heap doesn't degenerate into one uniform shape.
IMAGES: list[tuple[str, tuple[int, int], tuple[int, int, int]]] = [
    # portrait
    ("10000001", (600, 900), (180, 60, 60)),
    ("10000002", (480, 800), (200, 110, 50)),
    ("10000003", (500, 750), (180, 130, 70)),
    ("10000004", (520, 880), (120, 50, 100)),
    ("10000005", (560, 840), (90, 70, 140)),
    ("10000006", (540, 820), (160, 80, 90)),
    ("10000007", (500, 800), (200, 140, 120)),
    ("10000008", (600, 920), (110, 90, 60)),
    # landscape
    ("10000009", (900, 600), (60, 130, 160)),
    ("10000010", (1000, 560), (50, 170, 130)),
    ("10000011", (1100, 620), (70, 100, 180)),
    ("10000012", (900, 540), (100, 160, 90)),
    ("10000013", (960, 600), (40, 110, 150)),
    ("10000014", (1080, 640), (80, 140, 180)),
    # roughly-square
    ("10000015", (700, 700), (190, 160, 80)),
    ("10000016", (640, 680), (140, 100, 180)),
    ("10000017", (720, 700), (170, 80, 130)),
    # tall portrait
    ("10000018", (400, 900), (60, 80, 130)),
    ("10000019", (380, 880), (130, 60, 80)),
    # wide landscape
    ("10000020", (1200, 540), (170, 140, 70)),
    ("10000021", (1280, 560), (80, 180, 150)),
    # mixed
    ("10000022", (700, 900), (210, 130, 60)),
    ("10000023", (820, 620), (60, 150, 100)),
    ("10000024", (560, 780), (140, 90, 150)),
]


def main() -> None:
    data_dir = Path(__import__("os").environ["FLIST_WORKBENCH_DATA_DIR"])
    # Force character_archive to use the requested data dir.
    import documents as _docs

    _docs.user_data_dir = lambda: data_dir  # type: ignore[assignment]
    data_dir.mkdir(parents=True, exist_ok=True)

    live_images: list[dict] = []
    for idx, (image_id, (w, h), rgb) in enumerate(IMAGES):
        img = Image.new("RGB", (w, h), rgb)
        # Add a thin border so adjacent tiles in the gallery are visibly
        # distinct even when the colors are close.
        for x in range(w):
            img.putpixel((x, 0), (255, 255, 255))
            img.putpixel((x, h - 1), (255, 255, 255))
        for y in range(h):
            img.putpixel((0, y), (255, 255, 255))
            img.putpixel((w - 1, y), (255, 255, 255))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        data = buf.getvalue()
        character_archive.write_character_image(
            CHARACTER_ID, image_id, "png", data
        )
        live_images.append(
            {
                "image_id": image_id,
                "extension": "png",
                "height": str(h),
                "width": str(w),
                "description": "" if idx % 3 else f"Sample caption {idx + 1}",
                "sort_order": str(idx),
            }
        )

    live = {
        "id": CHARACTER_ID,
        "name": CHARACTER_NAME,
        "description": (
            "[b]This is a sample character used by the Images-tab UX "
            "screenshot harness.[/b] The body of this profile is irrelevant "
            "— the gallery heap on the right is the point."
        ),
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
        "images": live_images,
        "character_list": [],
        "timezone": 0,
        "current_user": {"inline_mode": 0, "animated_icons": True},
        "error": "",
        "fetched_at": 1,
    }
    character_archive.write_live(CHARACTER_ID, live)
    print(
        f"seeded {len(IMAGES)} images at {data_dir}/characters/{CHARACTER_ID}/"
    )


if __name__ == "__main__":
    main()
