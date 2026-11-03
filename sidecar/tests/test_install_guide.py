"""The Windows install guide names the files a release really publishes.

Every release body links to docs/INSTALL_WINDOWS.md, and a user looks
for the file name it gives on the Releases page and in SHA256SUMS.txt.
electron-builder.yml decides those names, so the guide is checked
against it rather than against anyone's memory of it.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
GUIDE = ROOT / "docs" / "INSTALL_WINDOWS.md"


def release_exe_names() -> set[str]:
    """The installer's and the portable exe's names, with the version
    left as `<version>` the way the guide writes it."""
    config = yaml.safe_load((ROOT / "electron-builder.yml").read_text(encoding="utf-8"))
    archs = {arch for target in config["win"]["target"] for arch in target["arch"]}
    assert archs == {"x64"}, "the guide only knows x64 builds"
    return {
        config[target]["artifactName"]
        .replace("${version}", "<version>")
        .replace("${arch}", "x64")
        .replace("${ext}", "exe")
        for target in ("nsis", "portable")
    }


def test_the_guide_names_exactly_the_installer_and_the_portable_exe():
    guide = GUIDE.read_text(encoding="utf-8")
    named = set(re.findall(r"F-list[ -]Workbench-<version>\S*?\.exe", guide))
    assert named == release_exe_names()
