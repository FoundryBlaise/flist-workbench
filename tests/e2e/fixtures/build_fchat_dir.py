"""Build the fixture F-Chat folder the e2e suite points the app at.

    python build_fchat_dir.py <out_dir>

Writes binary Logs with the sidecar's shared Log writer
(sidecar/tests/fchat_logs.py), so the app reads them through the same
parser as a real F-Chat folder. Folder and file names are lower-cased,
as F-Chat writes them. Every name and line here is invented or one of
the user's own characters; no real Log text belongs in this file.

The layout is what the specs assert against:

    azure viper/logs/antiquill          DM
    azure viper/logs/aina sato          DM
    lady amber blaise/logs/antiquill    DM
    lady amber blaise/logs/#fixture lounge   channel (never a DM)
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "sidecar" / "tests"))

from fchat_logs import action, ad, chat, utc, write_log  # noqa: E402


def build(root: Path) -> None:
    write_log(
        root / "azure viper" / "logs" / "antiquill",
        [
            chat("Azure Viper", "Evening. The lighthouse lamp is lit again.", at=utc(2024, 3, 9, 21, 0)),
            action("Antiquill", "tips his hat and sets a brass key on the table.", at=utc(2024, 3, 9, 21, 2)),
            chat("Azure Viper", "Then the tide map was right after all.", at=utc(2024, 3, 9, 21, 5)),
        ],
    )
    write_log(
        root / "azure viper" / "logs" / "aina sato",
        [
            chat("Aina Sato", "Are we still on for the market scene?", at=utc(2024, 4, 2, 18, 0)),
            chat("Azure Viper", "Yes, after the storm passes.", at=utc(2024, 4, 2, 18, 3)),
        ],
    )
    write_log(
        root / "lady amber blaise" / "logs" / "antiquill",
        [
            chat("Lady Amber Blaise", "The ledger is missing a page.", at=utc(2024, 5, 1, 20, 0)),
            action("Antiquill", "slides the torn page across the counter.", at=utc(2024, 5, 1, 20, 4)),
        ],
    )
    write_log(
        root / "lady amber blaise" / "logs" / "#fixture lounge",
        [
            ad("Antiquill", "Looking for a long story about clockwork ships.", at=utc(2024, 5, 2, 12, 0)),
            chat("Antiquill", "Anyone around tonight?", at=utc(2024, 5, 2, 12, 5)),
        ],
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: build_fchat_dir.py <out_dir>")
    build(Path(sys.argv[1]))
