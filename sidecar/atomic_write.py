"""Atomic file writes: a crash or power loss leaves the old file or the
new one, never a broken one.

Every file the sidecar writes goes through here. The bytes go to a temp
file of their own beside the target (`<name>.<random>.tmp`, so two
writers never share one), are flushed to disk, and then take the
target's place in one step.

A crash before that step leaves the temp file behind. Its name ends in
`TEMP_SUFFIX`, which no reader takes for a file of its own: the
archive's readers only match the names they know (`payload.json`,
`<image_id>.<ext>`, `<ISO>.zip`, ...), and the data-invariant checks
treat the suffix as scratch.
"""

from __future__ import annotations

import itertools
import json
import os
import random
import tempfile
import time
from pathlib import Path
from typing import Any, Iterable

#: What every temp file's name ends in.
TEMP_SUFFIX = ".tmp"


def is_temp(path: str | Path) -> bool:
    """Whether `path` is what an interrupted write left behind."""
    return Path(path).name.endswith(TEMP_SUFFIX)


def write_bytes(path: str | Path, data: bytes) -> None:
    """Replace `path` with `data` in one step, creating its folder."""
    target = Path(path)
    tmp = _temp_beside(target, data)
    try:
        _replace(tmp, target)
    except BaseException:
        _discard(tmp)
        raise
    _sync_folder(target.parent)


def write_text(path: str | Path, text: str) -> None:
    """`write_bytes` for UTF-8 text."""
    write_bytes(path, text.encode("utf-8"))


def write_json(path: str | Path, value: Any, **dumps: Any) -> None:
    """`write_text` for `json.dumps(value, **dumps)`."""
    write_text(path, json.dumps(value, **dumps))


def write_new(paths: Iterable[str | Path], data: bytes) -> Path:
    """Write `data` under the first of `paths` that nothing holds yet and
    return it. Never replaces a file, not even one that appears while
    this runs: the name is claimed in the same step that places the
    bytes. Raises `FileExistsError` when every path is taken. All paths
    must lie in one folder."""
    candidates = iter(paths)
    try:
        first = Path(next(candidates))
    except StopIteration:
        raise FileExistsError("no file name to write to") from None
    tmp = _temp_beside(first, data)
    try:
        for target in itertools.chain([first], map(Path, candidates)):
            if _place_new(tmp, target):
                _sync_folder(target.parent)
                return target
        raise FileExistsError(f"every name beside {first} is taken")
    finally:
        _discard(tmp)


def _temp_beside(target: Path, data: bytes) -> Path:
    """A new temp file in `target`'s folder holding `data`, on disk."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(
        dir=target.parent, prefix=f"{target.name}.", suffix=TEMP_SUFFIX
    )
    tmp = Path(name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
    except BaseException:
        _discard(tmp)
        raise
    return tmp


def _replace(tmp: Path, target: Path) -> None:
    """`os.replace`, retried once after a short jittered pause: OneDrive
    and Dropbox sync agents can hold the target open for milliseconds,
    which Windows answers with a sharing error."""
    try:
        os.replace(tmp, target)
    except OSError:
        time.sleep(0.05 + random.random() * 0.05)
        os.replace(tmp, target)


def _place_new(tmp: Path, target: Path) -> bool:
    """Give `tmp`'s bytes the name `target` unless that name is taken;
    False when it is. Windows' rename refuses to replace; elsewhere a
    hard link does (and the temp name is dropped by the caller)."""
    try:
        if os.name == "nt":
            os.rename(tmp, target)
        else:
            os.link(tmp, target)
    except FileExistsError:
        return False
    return True


def _discard(tmp: Path) -> None:
    try:
        tmp.unlink(missing_ok=True)
    except OSError:
        pass


def _sync_folder(folder: Path) -> None:
    """Make the new name itself durable. POSIX only: Windows cannot open
    a folder for flushing, and NTFS journals the rename."""
    if os.name == "nt":
        return
    try:
        fd = os.open(folder, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)
