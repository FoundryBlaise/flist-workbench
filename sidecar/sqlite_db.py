"""Open the app's SQLite files: WAL, a busy timeout, numbered migrations.

labels.db and settings.db are opened per request, from the REST
routes, the MCP tools and the ingest thread at once. Every connection
gets the same treatment here, so none of them can forget it:

- WAL, so a reader (an ingest walking Labels) never blocks a writer (a
  model saving a verdict) and the other way round.
- An explicit busy timeout, so two writers queue instead of the second
  failing with "database is locked".
- Numbered migrations tracked in `PRAGMA user_version`. A connection to
  a database at the latest version runs none; an older one runs the
  missing steps once, each in its own transaction together with the
  version bump, so a step either lands with its number or not at all.

A migration, once released, never changes: a schema change is a new
step at the end of the list.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Callable, Sequence

log = logging.getLogger(__name__)

#: How long a connection waits for another one's write to finish.
#: Writes are short (a batch of Labels, one ingest batch of the keyword
#: index), so this is only reached when something is badly stuck.
BUSY_TIMEOUT_S = 15.0

Migration = Callable[[sqlite3.Connection], None]

#: One switch to WAL or migration run at a time in this process;
#: `BEGIN IMMEDIATE` below covers another process opening the same file.
_SETUP_LOCK = threading.Lock()


def statements(*sql: str) -> Migration:
    """A migration that runs these statements in order.

    Not `executescript`: that commits first, which would split a step
    from its version bump.
    """

    def run(conn: sqlite3.Connection) -> None:
        for statement in sql:
            conn.execute(statement)

    return run


def connect(path: Path, migrations: Sequence[Migration]) -> sqlite3.Connection:
    # check_same_thread=False: FastAPI may run a dependency's setup, the
    # endpoint body and the teardown on different threadpool workers.
    # Connections are per request, never shared between concurrent users.
    conn = sqlite3.connect(path, timeout=BUSY_TIMEOUT_S, check_same_thread=False)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout = {int(BUSY_TIMEOUT_S * 1000)}")
        if conn.execute("PRAGMA journal_mode").fetchone()[0] != "wal":
            with _SETUP_LOCK:
                _use_wal(conn, path)
        if user_version(conn) < len(migrations):
            with _SETUP_LOCK:
                _migrate(conn, path, migrations)
    except BaseException:
        conn.close()
        raise
    return conn


def user_version(conn: sqlite3.Connection) -> int:
    return int(conn.execute("PRAGMA user_version").fetchone()[0])


def _use_wal(conn: sqlite3.Connection, path: Path) -> None:
    """Switch the file to WAL; it stays WAL for every later connection.

    The switch needs the file to itself and SQLite does not wait for
    that through the busy timeout, so it is retried here while other
    connections finish what they are reading.
    """
    deadline = time.monotonic() + BUSY_TIMEOUT_S
    while True:
        try:
            if conn.execute("PRAGMA journal_mode = WAL").fetchone()[0] == "wal":
                return
        except sqlite3.OperationalError:
            pass
        if time.monotonic() > deadline:
            # Still usable without WAL, just with more waiting; the next
            # connection tries again.
            log.warning("could not switch %s to WAL", path.name)
            return
        time.sleep(0.05)


def _migrate(conn: sqlite3.Connection, path: Path, migrations: Sequence[Migration]) -> None:
    # Explicit transactions: Python's implicit ones do not cover DDL.
    conn.isolation_level = None
    try:
        for version, step in enumerate(migrations, start=1):
            conn.execute("BEGIN IMMEDIATE")
            try:
                # Re-read under the write lock: another connection may
                # have run this step since the check in connect().
                if user_version(conn) < version:
                    step(conn)
                    conn.execute(f"PRAGMA user_version = {version}")
                conn.execute("COMMIT")
            except sqlite3.DatabaseError:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                # The database stays at the last step that landed and the
                # next connection tries again. Failing here would stop
                # the sidecar from serving data the user still has.
                log.exception("migration %d of %s failed", version, path.name)
                return
    finally:
        conn.isolation_level = ""
