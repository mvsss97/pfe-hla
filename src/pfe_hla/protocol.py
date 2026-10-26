"""Versioned review protocols.

A formal ``review`` search must name a frozen protocol version. Freezing stores
the SHA-256 of the protocol document and the git commit, so every PRISMA count
can be traced back to the exact text that governed it. A provisional version is
usable but explicitly flagged until the supervisor validates it.
"""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

from pfe_hla.library import utc_now

PROTOCOL_STATUSES = ("provisional", "validated", "retired")


def document_sha256(path: Path | str) -> str:
    # Normalise line endings so a Windows checkout and the CI runner agree.
    content = Path(path).read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(content).hexdigest()


def freeze_protocol(
    connection: sqlite3.Connection,
    *,
    version: str,
    document: Path | str,
    git_commit: str = "",
    note: str = "",
) -> sqlite3.Row:
    """Record a protocol version, refusing to silently re-freeze edited text."""

    version = version.strip()
    if not version:
        raise ValueError("A protocol version label is required")
    digest = document_sha256(document)
    existing = connection.execute(
        "SELECT * FROM protocol_versions WHERE version=?", (version,)
    ).fetchone()
    if existing is not None:
        if existing["sha256"] != digest:
            raise ValueError(
                f"Protocol {version} was frozen with another text; bump the version "
                "and document the amendment instead of overwriting it"
            )
        return existing
    connection.execute(
        """
        INSERT INTO protocol_versions(version, sha256, git_commit, status, frozen_at, note)
        VALUES (?, ?, ?, 'provisional', ?, ?)
        """,
        (version, digest, git_commit.strip(), utc_now(), note.strip()),
    )
    return connection.execute(
        "SELECT * FROM protocol_versions WHERE version=?", (version,)
    ).fetchone()


def set_protocol_status(connection: sqlite3.Connection, *, version: str, status: str) -> None:
    if status not in PROTOCOL_STATUSES:
        raise ValueError(f"status must be one of {', '.join(PROTOCOL_STATUSES)}")
    cursor = connection.execute(
        "UPDATE protocol_versions SET status=? WHERE version=?", (status, version)
    )
    if cursor.rowcount == 0:
        raise KeyError(f"Unknown protocol version {version}")


def active_protocol(connection: sqlite3.Connection) -> sqlite3.Row | None:
    """Latest version that has not been retired."""

    return connection.execute(
        """
        SELECT * FROM protocol_versions WHERE status != 'retired'
        ORDER BY frozen_at DESC, version DESC LIMIT 1
        """
    ).fetchone()


def require_protocol(connection: sqlite3.Connection, version: str) -> sqlite3.Row:
    row = connection.execute(
        "SELECT * FROM protocol_versions WHERE version=?", (version,)
    ).fetchone()
    if row is None:
        raise ValueError(
            f"Protocol {version} is not frozen; run `pfe_hla protocol-freeze {version}` first"
        )
    if row["status"] == "retired":
        raise ValueError(f"Protocol {version} is retired")
    return row
