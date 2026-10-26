"""Reading queue: which papers the agents read next, and where their PDF lives.

Priority comes first from the human (a paper kept or requested on Telegram),
then from strong AI screening suggestions. A paper whose PDF repeatedly fails is
parked after ``MAX_ATTEMPTS`` so one broken link never blocks the queue.
"""

from __future__ import annotations

import re
import sqlite3
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

from pfe_hla.fulltext import fetch_and_extract
from pfe_hla.library import utc_now

MAX_ATTEMPTS = 3
AI_QUEUE_PRIORITY = 40


@dataclass(frozen=True, slots=True)
class FetchOutcome:
    paper_id: int
    status: str  # ready | fetched | no_pdf | error
    detail: str = ""


def _https(value: str) -> str:
    parsed = urllib.parse.urlparse(value or "")
    return value if parsed.scheme == "https" and parsed.hostname else ""


def resolve_pdf_url(paper: sqlite3.Row | dict) -> str:
    """Best open-access PDF URL derivable from the recorded metadata."""

    direct = _https(str(paper["pdf_url"] or ""))
    if direct:
        return direct
    arxiv_id = str(paper["arxiv_id"] or "").strip()
    doi = str(paper["doi"] or "").strip().lower()
    url = str(paper["url"] or "").strip()
    if not arxiv_id and doi.startswith("10.48550/arxiv."):
        arxiv_id = doi.removeprefix("10.48550/arxiv.")
    if not arxiv_id:
        match = re.search(r"arxiv\.org/(?:abs|pdf)/([^?#\s]+?)(?:v\d+)?(?:\.pdf)?$", url)
        if match:
            arxiv_id = match.group(1)
    if arxiv_id:
        return f"https://arxiv.org/pdf/{arxiv_id}"
    if doi.startswith("10.18653/v1/"):
        return f"https://aclanthology.org/{doi.removeprefix('10.18653/v1/')}.pdf"
    match = re.search(r"aclanthology\.org/([A-Za-z0-9.\-]+?)/?$", url)
    if match and not match.group(1).endswith(".pdf"):
        return f"https://aclanthology.org/{match.group(1)}.pdf"
    match = re.search(r"openreview\.net/forum\?id=([\w\-]+)", url)
    if match:
        return f"https://openreview.net/pdf?id={match.group(1)}"
    if url.lower().endswith(".pdf"):
        return _https(url)
    return ""


def auto_queue_from_ai(
    connection: sqlite3.Connection,
    *,
    min_relevance: int = 4,
    min_confidence: float = 0.7,
    limit: int = 10,
) -> int:
    """Queue papers the AI judged clearly relevant, unless a human excluded them."""

    rows = list(
        connection.execute(
            """
            WITH latest AS (
                SELECT paper_id, MAX(id) AS id FROM ai_screening GROUP BY paper_id
            )
            SELECT ai.paper_id, ai.relevance FROM ai_screening AS ai
            JOIN latest ON latest.id = ai.id
            JOIN papers ON papers.id = ai.paper_id
            WHERE ai.decision = 'include' AND ai.relevance >= ? AND ai.confidence >= ?
              AND papers.status NOT IN ('excluded')
              AND NOT EXISTS (SELECT 1 FROM reading_queue q WHERE q.paper_id = ai.paper_id)
              AND NOT EXISTS (SELECT 1 FROM paper_sheets s WHERE s.paper_id = ai.paper_id)
              AND NOT EXISTS (
                  SELECT 1 FROM triage_events t WHERE t.paper_id = ai.paper_id
                    AND t.decision = 'exclude'
              )
            ORDER BY ai.relevance DESC, papers.publication_year DESC
            LIMIT ?
            """,
            (min_relevance, min_confidence, limit),
        )
    )
    for row in rows:
        connection.execute(
            """
            INSERT OR IGNORE INTO reading_queue(paper_id, priority, reason, queued_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                row["paper_id"],
                AI_QUEUE_PRIORITY + int(row["relevance"]),
                f"Suggestion IA : pertinence {row['relevance']}/5",
                utc_now(),
            ),
        )
    return len(rows)


def pending_reading(connection: sqlite3.Connection, *, limit: int) -> list[sqlite3.Row]:
    return list(
        connection.execute(
            """
            SELECT papers.*, q.priority, q.reason, q.attempts
            FROM reading_queue AS q JOIN papers ON papers.id = q.paper_id
            WHERE q.done_at IS NULL AND q.attempts < ?
              AND NOT EXISTS (SELECT 1 FROM paper_sheets s WHERE s.paper_id = q.paper_id)
            ORDER BY q.priority DESC, q.queued_at
            LIMIT ?
            """,
            (MAX_ATTEMPTS, limit),
        )
    )


def extracted_text_path(connection: sqlite3.Connection, paper_id: int) -> Path | None:
    row = connection.execute(
        """
        SELECT text_path FROM paper_documents
        WHERE paper_id=? AND extraction_status='extracted'
        """,
        (paper_id,),
    ).fetchone()
    if row is None:
        return None
    path = Path(row["text_path"])
    return path if path.exists() else None


def fetch_reading_batch(
    connection: sqlite3.Connection,
    *,
    storage_root: Path,
    limit: int,
) -> list[FetchOutcome]:
    """Make sure the next queued papers have an extracted full text on disk."""

    outcomes: list[FetchOutcome] = []
    for paper in pending_reading(connection, limit=limit):
        paper_id = int(paper["id"])
        if extracted_text_path(connection, paper_id) is not None:
            outcomes.append(FetchOutcome(paper_id, "ready"))
            continue
        pdf_url = resolve_pdf_url(paper)
        if not pdf_url:
            connection.execute(
                """
                UPDATE reading_queue SET attempts=?, last_error=? WHERE paper_id=?
                """,
                (MAX_ATTEMPTS, "Aucun PDF en accès ouvert trouvé", paper_id),
            )
            outcomes.append(FetchOutcome(paper_id, "no_pdf", "no open-access PDF URL"))
            continue
        if not paper["pdf_url"]:
            connection.execute(
                "UPDATE papers SET pdf_url=?, updated_at=? WHERE id=?",
                (pdf_url, utc_now(), paper_id),
            )
        try:
            document = fetch_and_extract(
                connection, paper_id=paper_id, storage_root=storage_root
            )
        except Exception as exc:  # recorded on the queue; the batch continues
            detail = f"{type(exc).__name__}: {exc}"[:300]
            connection.execute(
                """
                UPDATE reading_queue SET attempts=attempts+1, last_error=? WHERE paper_id=?
                """,
                (detail, paper_id),
            )
            outcomes.append(FetchOutcome(paper_id, "error", detail))
            continue
        outcomes.append(
            FetchOutcome(paper_id, "fetched", f"{document.page_count} pages")
        )
    return outcomes


def mark_read(connection: sqlite3.Connection, paper_id: int) -> None:
    connection.execute(
        "UPDATE reading_queue SET done_at=?, last_error='' WHERE paper_id=?",
        (utc_now(), paper_id),
    )
