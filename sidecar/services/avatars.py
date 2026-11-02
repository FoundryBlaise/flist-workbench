"""The avatar cache under `<userdata>/avatars/`, and F-list's stand-in
for a name without one."""

import character_archive

PLACEHOLDER_SIZE = 5827  # bytes returned by F-list when a name has no avatar


def cleanup_placeholder_avatars() -> int:
    """One-time cache cleanup at sidecar startup.

    Early Tier-1 sidecars built the wrong avatar URL (underscores
    instead of spaces), so F-list always returned its 5827-byte
    "no avatar" placeholder and we cached those PNGs to disk. After
    the URL fix landed, the cached placeholders kept tripping the
    placeholder-size check in /flist/avatar/{name} and serving 404
    even for characters that DO have a real avatar. Deleting any
    file matching the placeholder size lets the next request
    re-fetch through the fixed URL.

    Idempotent — after the first run there's nothing left to delete.
    """
    avatars = character_archive.avatars_root()
    if not avatars.exists():
        return 0
    deleted = 0
    for entry in avatars.iterdir():
        try:
            if entry.is_file() and entry.stat().st_size == PLACEHOLDER_SIZE:
                entry.unlink()
                deleted += 1
        except OSError:
            continue
    return deleted
