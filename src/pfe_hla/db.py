"""SQLite persistence and schema lifecycle."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

SCHEMA_VERSION = 3


def _column_exists(connection: sqlite3.Connection, table: str, column: str) -> bool:
    return any(
        row["name"] == column
        for row in connection.execute(f"PRAGMA table_info({table})")  # noqa: S608
    )


def _migrate(connection: sqlite3.Connection, from_version: int) -> None:
    """Apply additive migrations.

    New tables (v2 agents, v3 tags, news and translations) already exist at this
    point because the schema script uses CREATE IF NOT EXISTS; only column
    additions live here.
    """

    if from_version < 2 and not _column_exists(
        connection, "search_run_details", "protocol_version"
    ):
        connection.execute("ALTER TABLE search_run_details ADD COLUMN protocol_version TEXT")
    if from_version < 3:
        for column in ("definition_fr", "example_fr"):
            if not _column_exists(connection, "vocabulary", column):
                connection.execute(
                    f"ALTER TABLE vocabulary ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"
                )


def connect(path: Path | str) -> sqlite3.Connection:
    db_path = Path(path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def init_database(path: Path | str) -> None:
    schema_path = Path(__file__).with_name("schema.sql")
    connection = connect(path)
    try:
        with connection:
            connection.executescript(schema_path.read_text(encoding="utf-8"))
            row = connection.execute("SELECT version FROM schema_meta LIMIT 1").fetchone()
            if row is None:
                connection.execute("INSERT INTO schema_meta(version) VALUES (?)", (SCHEMA_VERSION,))
            elif row["version"] < SCHEMA_VERSION:
                _migrate(connection, int(row["version"]))
                connection.execute("UPDATE schema_meta SET version=?", (SCHEMA_VERSION,))
            elif row["version"] != SCHEMA_VERSION:
                raise RuntimeError(
                    f"Database schema {row['version']} is incompatible with {SCHEMA_VERSION}."
                )
    finally:
        connection.close()


@contextmanager
def transaction(path: Path | str) -> Iterator[sqlite3.Connection]:
    connection = connect(path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()
