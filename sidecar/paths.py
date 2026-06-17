"""Where Workbench keeps its data on disk.

Single source of truth for the user-data root path. Lifted out of
documents.py during the Snippets removal (Phase 9-ish, 2026-06-17)
so the path helper survives that module's deletion.

Override via FLIST_WORKBENCH_DATA_DIR for tests / portable installs /
sandbox runs. Default lives under the platform's standard config root
with a kebab-case app name (NOT the productName "F-list Workbench"
with spaces — keep these two stable forever, the on-disk layout is
load-bearing for users who already have data here).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def user_data_dir() -> Path:
    override = os.environ.get("FLIST_WORKBENCH_DATA_DIR")
    if override:
        return Path(override)
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "flist-workbench"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "flist-workbench"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "flist-workbench"
