"""Corpus-wide IC/OOC label counts.

Lifted out of the `/labels/rollup` handler so the MCP status tool and
the REST route share one implementation. Walks every
(character × partner) log under the configured data directory — a few
seconds on a large corpus, so callers should treat it as expensive.
"""

from __future__ import annotations

from typing import Any

import aliases as aliases_store
import labels as labels_store
import settings as settings_store
from logs import LogDirError, list_characters, list_partners, read_messages


def rollup() -> dict[str, Any]:
    """Aggregate IC/OOC/Unlabeled counts across every character.

    Raises `LogDirError` when the configured F-Chat data directory is
    missing; callers decide whether that is a 404 or a soft failure.
    """
    characters = list_characters()

    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    totals = {
        labels_store.LABEL_IC: 0,
        labels_store.LABEL_OOC: 0,
        labels_store.LABEL_UNLABELED: 0,
    }
    # Track manual-override count separately — it's a useful "how much
    # of this did I curate" signal independent of IC/OOC totals.
    manual_overrides = int(
        labels_conn.execute(
            "SELECT COUNT(*) FROM labels WHERE source = 'manual'"
        ).fetchone()[0]
        or 0
    )
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        for char in characters:
            try:
                entries = list_partners(char.name)
            except LogDirError:
                continue
            for entry in entries:
                try:
                    messages = list(read_messages(char.name, entry.name))
                except LogDirError:
                    continue
                alias_group = aliases_store.all_names_for(
                    labels_conn, char.name, entry.name
                )
                counts = labels_store.stats(
                    labels_conn,
                    char.name,
                    entry.name,
                    messages,
                    lab_settings,
                    partner_aliases=alias_group,
                )
                for k, v in counts.items():
                    totals[k] = totals.get(k, 0) + v
    finally:
        settings_conn.close()
        labels_conn.close()
    total = sum(totals.values())
    return {
        "ic": totals[labels_store.LABEL_IC],
        "ooc": totals[labels_store.LABEL_OOC],
        "unlabeled": totals[labels_store.LABEL_UNLABELED],
        "manual": manual_overrides,
        "total": total,
        "character_count": len(characters),
    }
