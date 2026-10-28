"""Supervisor reading list: resolve, import, tag and queue for the reading agent.

The list (``data/supervisor_reading_list.json``) holds bibliographic data only.
Each entry is matched to OpenAlex/arXiv by DOI, arXiv id or exact title; an
entry that cannot be matched is still imported with its curated metadata so it
stays visible. Imported papers are tagged ``encadrant`` and queued for the
reading agent according to their priority. They are *identified via other
methods* (supervisor recommendation): they do not enter the formal PRISMA
database-search counts unless a documented review run retrieves them.
"""

from __future__ import annotations

import difflib
import json
import sqlite3
import time
import urllib.error
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from pfe_hla.collect import (
    ARXIV_MIN_INTERVAL_SECONDS,
    OPENALEX_SELECT_FIELDS,
    _parse_arxiv,
    _parse_openalex,
    _request_json,
    _request_xml,
)
from pfe_hla.library import PaperRecord, normalize_title, paper_key, upsert_paper, utc_now
from pfe_hla.reading import resolve_pdf_url
from pfe_hla.sync import queue_for_reading

DEFAULT_LIST = Path(__file__).resolve().parents[2] / "data" / "supervisor_reading_list.json"
TAG = "encadrant"
READING_PRIORITY = {1: 85, 2: 55}
MAX_RESOLUTION_ATTEMPTS = 3
TITLE_MATCH_THRESHOLD = 0.9


@dataclass(slots=True)
class Resolution:
    record: PaperRecord | None
    method: str = "none"
    score: float = 0.0


class Resolver(Protocol):
    def resolve(self, entry: dict[str, Any]) -> Resolution: ...


def title_similarity(left: str, right: str) -> float:
    return difflib.SequenceMatcher(None, normalize_title(left), normalize_title(right)).ratio()


@dataclass(slots=True)
class ScholarlyResolver:
    """Match an entry on OpenAlex (DOI, then title) or arXiv (id)."""

    email: str | None = None
    _last_arxiv: float = field(default=0.0)

    @property
    def _user_agent(self) -> str:
        return f"PFE-HLA/0.3 ({self.email or 'no-contact-configured'})"

    def _arxiv(self, arxiv_id: str) -> PaperRecord | None:
        wait = ARXIV_MIN_INTERVAL_SECONDS - (time.monotonic() - self._last_arxiv)
        if wait > 0:
            time.sleep(wait)
        self._last_arxiv = time.monotonic()
        url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(
            {"id_list": arxiv_id, "max_results": "1"}
        )
        records = _parse_arxiv(_request_xml(url, user_agent=self._user_agent))
        return records[0] if records else None

    def _openalex_doi(self, doi: str) -> PaperRecord | None:
        url = (
            "https://api.openalex.org/works/doi:"
            + urllib.parse.quote(doi.lower(), safe="/")
            + "?"
            + urllib.parse.urlencode({"select": ",".join(OPENALEX_SELECT_FIELDS)})
        )
        work = _request_json(url, user_agent=self._user_agent)
        records = _parse_openalex({"results": [work]})
        return records[0] if records else None

    def _openalex_title(self, title: str) -> tuple[PaperRecord | None, float]:
        url = "https://api.openalex.org/works?" + urllib.parse.urlencode(
            {
                "search": title,
                "per-page": "5",
                "select": ",".join(OPENALEX_SELECT_FIELDS),
            }
        )
        best, best_score = None, 0.0
        for record in _parse_openalex(_request_json(url, user_agent=self._user_agent)):
            score = title_similarity(title, record.title)
            if score > best_score:
                best, best_score = record, score
        return best, best_score

    def resolve(self, entry: dict[str, Any]) -> Resolution:
        try:
            if entry.get("arxiv"):
                record = self._arxiv(str(entry["arxiv"]))
                if record is not None:
                    return Resolution(record, "arxiv", 1.0)
            if entry.get("doi"):
                record = self._openalex_doi(str(entry["doi"]))
                if record is not None:
                    return Resolution(record, "doi", 1.0)
            if entry.get("title_exact", True):
                record, score = self._openalex_title(str(entry["title"]))
                if record is not None and score >= TITLE_MATCH_THRESHOLD:
                    return Resolution(record, "title", round(score, 3))
        except (OSError, ValueError, urllib.error.URLError):
            return Resolution(None, "error")
        return Resolution(None, "none")


def _curated_record(entry: dict[str, Any]) -> PaperRecord:
    return PaperRecord(
        source="Encadrant",
        external_id=str(entry["id"]),
        title=str(entry["title"]),
        doi=str(entry.get("doi") or ""),
        arxiv_id=str(entry.get("arxiv") or ""),
        publication_year=entry.get("year"),
        venue=str(entry.get("venue") or ""),
        url=str(entry.get("url") or ""),
    )


def _ensure_run(connection: sqlite3.Connection, count: int) -> int:
    row = connection.execute(
        """
        SELECT id FROM search_runs WHERE source='Encadrant' AND query='supervisor reading list'
        ORDER BY id LIMIT 1
        """
    ).fetchone()
    timestamp = utc_now()
    if row is not None:
        connection.execute(
            "UPDATE search_runs SET finished_at=?, returned_count=?, status='ok' WHERE id=?",
            (timestamp, count, row["id"]),
        )
        return int(row["id"])
    cursor = connection.execute(
        """
        INSERT INTO search_runs(
            source, query, started_at, finished_at, returned_count, inserted_count, status
        ) VALUES ('Encadrant', 'supervisor reading list', ?, ?, ?, 0, 'ok')
        """,
        (timestamp, timestamp, count),
    )
    run_id = int(cursor.lastrowid)
    connection.execute(
        """
        INSERT INTO search_run_details(run_id, executed_query, request_url, run_kind)
        VALUES (?, 'supervisor reading list', 'data/supervisor_reading_list.json', 'pilot')
        """,
        (run_id,),
    )
    return run_id


def _existing_notes(connection: sqlite3.Connection) -> dict[str, tuple[int, dict]]:
    notes = {}
    for row in connection.execute("SELECT paper_id, note_json FROM paper_tags WHERE tag=?", (TAG,)):
        note = json.loads(row["note_json"] or "{}")
        if note.get("id"):
            notes[str(note["id"])] = (int(row["paper_id"]), note)
    return notes


@dataclass(slots=True)
class ImportReport:
    total: int = 0
    resolved: int = 0
    unresolved: list[str] = field(default_factory=list)
    queued: int = 0


def import_reading_list(
    connection: sqlite3.Connection,
    path: Path | str,
    resolver: Resolver | None = None,
) -> ImportReport:
    """Idempotently import the list; unresolved entries are retried a few times."""

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    entries = data.get("papers", [])
    run_id = _ensure_run(connection, len(entries))
    existing = _existing_notes(connection)
    report = ImportReport(total=len(entries))
    timestamp = utc_now()
    resolved_methods = ("arxiv", "doi", "title")
    for rank, entry in enumerate(entries, start=1):
        entry_id = str(entry["id"])
        known = existing.get(entry_id)
        note = dict(known[1]) if known else {}
        resolution = Resolution(None, str(note.get("resolved", "none")))
        needs_lookup = note.get("resolved") not in resolved_methods and int(
            note.get("attempts", 0)
        ) < MAX_RESOLUTION_ATTEMPTS
        if resolver is not None and needs_lookup:
            resolution = resolver.resolve(entry)
            note["attempts"] = int(note.get("attempts", 0)) + 1

        if resolution.record is not None:
            record = resolution.record
            # Curated venue/year fill gaps the scholarly index may leave empty.
            record.venue = record.venue or str(entry.get("venue") or "")
            record.publication_year = record.publication_year or entry.get("year")
            paper_id, _inserted = upsert_paper(connection, record)
            if not entry.get("title_exact", True):
                # Placeholder titles (e.g. "OASIS (arXiv …)") give way to the real one.
                connection.execute(
                    "UPDATE papers SET title=?, updated_at=? WHERE id=?",
                    (record.title, timestamp, paper_id),
                )
            if known and known[0] != paper_id:
                connection.execute(
                    "DELETE FROM paper_tags WHERE paper_id=? AND tag=?", (known[0], TAG)
                )
            note["resolved"], note["score"] = resolution.method, resolution.score
        elif known:
            # Already imported: keep the same paper, never re-insert a variant.
            paper_id = known[0]
            if note.get("resolved") not in resolved_methods:
                note["resolved"] = resolution.method
        else:
            paper_id, _inserted = upsert_paper(connection, _curated_record(entry))
            note["resolved"] = resolution.method

        connection.execute(
            "INSERT OR IGNORE INTO paper_hits(run_id, paper_id, source_rank) VALUES (?, ?, ?)",
            (run_id, paper_id, rank),
        )
        note.update(
            {
                "id": entry_id,
                "short": entry.get("short", entry_id),
                "family": entry.get("family", ""),
                "priority": int(entry.get("priority", 3)),
                "role": entry.get("role", ""),
                "venue": entry.get("venue", ""),
                "year": entry.get("year"),
            }
        )
        connection.execute(
            """
            INSERT INTO paper_tags(paper_id, tag, note_json, tagged_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(paper_id, tag) DO UPDATE SET note_json=excluded.note_json
            """,
            (paper_id, TAG, json.dumps(note, ensure_ascii=False), timestamp),
        )
        if note["resolved"] in resolved_methods:
            report.resolved += 1
        else:
            report.unresolved.append(entry.get("short", entry_id))
        reading_priority = READING_PRIORITY.get(note["priority"])
        if reading_priority is not None:
            queue_for_reading(
                connection,
                paper_id,
                priority=reading_priority,
                reason=f"Liste de l'encadrant : {note['short']}",
            )
            report.queued += 1
    return report


def supervisor_papers(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    """Tagged papers with their reading status, for the site and the bot."""

    rows = connection.execute(
        """
        SELECT papers.id, papers.canonical_key, papers.title, papers.url, papers.pdf_url,
               papers.arxiv_id, papers.doi,
               papers.publication_year, papers.venue, papers.status, paper_tags.note_json,
               (SELECT 1 FROM paper_sheets s WHERE s.paper_id = papers.id) AS has_sheet,
               tr.title_fr,
               q.done_at, q.attempts, q.last_error
        FROM paper_tags
        JOIN papers ON papers.id = paper_tags.paper_id
        LEFT JOIN reading_queue AS q ON q.paper_id = papers.id
        LEFT JOIN paper_translations AS tr ON tr.paper_id = papers.id
        WHERE paper_tags.tag = ?
        """,
        (TAG,),
    )
    items = []
    for row in rows:
        note = json.loads(row["note_json"] or "{}")
        if row["has_sheet"]:
            reading = "sheet"
        elif row["last_error"]:
            reading = "no_pdf" if "PDF" in str(row["last_error"]) else "error"
        elif row["attempts"] is not None and row["done_at"] is None:
            reading = "queued"
        else:
            reading = "not_queued"
        items.append(
            {
                "key": paper_key(str(row["canonical_key"])),
                "id": note.get("id"),
                "short": note.get("short"),
                "title": row["title"],
                "titleFr": row["title_fr"] or "",
                "family": note.get("family"),
                "priority": note.get("priority"),
                "role": note.get("role"),
                # The curated venue/year (e.g. AAAI 2021) beat an arXiv preprint's.
                "venue": note.get("venue") or row["venue"],
                "year": note.get("year") or row["publication_year"],
                "url": row["url"] or row["pdf_url"],
                "pdf": resolve_pdf_url(row),
                "status": row["status"],
                "resolved": note.get("resolved"),
                "reading": reading,
                "readingError": row["last_error"] or "",
            }
        )
    items.sort(key=lambda item: (item["priority"] or 9, item["family"] or "", item["year"] or 0))
    return items


def load_families(path: Path | str = DEFAULT_LIST) -> dict[str, str]:
    """French labels of the list's families (empty when the file is missing)."""

    try:
        families = json.loads(Path(path).read_text(encoding="utf-8")).get("families", {})
    except (OSError, ValueError):
        return {}
    return {str(key): str(value) for key, value in families.items()}
