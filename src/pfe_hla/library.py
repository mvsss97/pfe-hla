"""Paper metadata normalization, deduplication and curated seeds."""

from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def normalize_doi(value: str | None) -> str:
    if not value:
        return ""
    doi = value.strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if doi.startswith(prefix):
            doi = doi[len(prefix) :]
    return doi.strip()


def normalize_arxiv_id(value: str | None) -> str:
    if not value:
        return ""
    candidate = value.strip().lower()
    candidate = candidate.removeprefix("arxiv:")
    candidate = re.sub(r"v\d+$", "", candidate)
    return candidate


def normalize_title(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    without_marks = "".join(
        character for character in decomposed if not unicodedata.combining(character)
    )
    spaced = "".join(
        character if character.isalnum() else " " for character in without_marks
    )
    ascii_title = spaced.encode("ascii", "ignore").decode()
    return " ".join(re.findall(r"[a-z0-9]+", ascii_title.lower()))


def canonical_key(*, doi: str = "", arxiv_id: str = "", title: str) -> str:
    clean_doi = normalize_doi(doi)
    if clean_doi:
        return f"doi:{clean_doi}"
    clean_arxiv = normalize_arxiv_id(arxiv_id)
    if clean_arxiv:
        return f"arxiv:{clean_arxiv}"
    return f"title:{normalize_title(title)}"


def _strong_identifiers_conflict(
    left_doi: str | None,
    left_arxiv: str | None,
    right_doi: str | None,
    right_arxiv: str | None,
) -> bool:
    left_clean_doi = normalize_doi(left_doi)
    right_clean_doi = normalize_doi(right_doi)
    left_clean_arxiv = normalize_arxiv_id(left_arxiv)
    right_clean_arxiv = normalize_arxiv_id(right_arxiv)
    return bool(
        (left_clean_doi and right_clean_doi and left_clean_doi != right_clean_doi)
        or (
            left_clean_arxiv
            and right_clean_arxiv
            and left_clean_arxiv != right_clean_arxiv
        )
    )


@dataclass(slots=True)
class PaperRecord:
    source: str
    title: str
    external_id: str = ""
    doi: str = ""
    arxiv_id: str = ""
    abstract: str = ""
    authors: list[str] = field(default_factory=list)
    publication_year: int | None = None
    venue: str = ""
    language: str = "en"
    url: str = ""
    pdf_url: str = ""
    status: str = "identified"
    exclusion_code: str | None = None
    screening_reason: str = ""

    @classmethod
    def from_mapping(cls, item: dict[str, Any]) -> PaperRecord:
        allowed = {field.name for field in cls.__dataclass_fields__.values()}
        return cls(**{key: value for key, value in item.items() if key in allowed})


def upsert_paper(connection: sqlite3.Connection, paper: PaperRecord) -> tuple[int, bool]:
    """Insert metadata or merge non-empty fields into the existing canonical paper."""

    key = canonical_key(doi=paper.doi, arxiv_id=paper.arxiv_id, title=paper.title)
    clean_doi = normalize_doi(paper.doi)
    clean_arxiv = normalize_arxiv_id(paper.arxiv_id)
    existing = connection.execute(
        """
        SELECT id FROM papers
        WHERE canonical_key = ?
           OR (? != '' AND doi = ?)
           OR (? != '' AND arxiv_id = ?)
        LIMIT 1
        """,
        (key, clean_doi, clean_doi, clean_arxiv, clean_arxiv),
    ).fetchone()
    aliases = [
        ("doi", clean_doi),
        ("arxiv", clean_arxiv),
        (f"external:{paper.source.casefold()}", paper.external_id.strip()),
    ]
    aliases = [(kind, value) for kind, value in aliases if value]
    if existing is None:
        for alias_type, alias_value in aliases:
            existing = connection.execute(
                """
                SELECT papers.id FROM paper_aliases
                JOIN papers ON papers.id=paper_aliases.paper_id
                WHERE alias_type=? AND alias_value=?
                """,
                (alias_type, alias_value),
            ).fetchone()
            if existing is not None:
                break
    if existing is None:
        title_key = normalize_title(paper.title)
        existing = next(
            (
                row
                for row in connection.execute(
                    "SELECT id, title, doi, arxiv_id FROM papers"
                )
                if normalize_title(row["title"]) == title_key
                and not _strong_identifiers_conflict(
                    row["doi"], row["arxiv_id"], clean_doi, clean_arxiv
                )
            ),
            None,
        )
    timestamp = utc_now()
    values = (
        key,
        paper.source,
        paper.external_id,
        clean_doi or None,
        clean_arxiv or None,
        paper.title.strip(),
        paper.abstract.strip(),
        json.dumps(paper.authors, ensure_ascii=False),
        paper.publication_year,
        paper.venue.strip(),
        paper.language or "en",
        paper.url.strip(),
        paper.pdf_url.strip(),
        paper.status,
        paper.exclusion_code,
        paper.screening_reason.strip(),
        timestamp,
        timestamp,
    )
    if existing is None:
        cursor = connection.execute(
            """
            INSERT INTO papers(
                canonical_key, source, external_id, doi, arxiv_id, title, abstract,
                authors_json, publication_year, venue, language, url, pdf_url, status,
                exclusion_code, screening_reason, discovered_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            values,
        )
        paper_id = int(cursor.lastrowid)
        for alias_type, alias_value in aliases:
            connection.execute(
                """
                INSERT OR IGNORE INTO paper_aliases(paper_id, alias_type, alias_value)
                VALUES (?, ?, ?)
                """,
                (paper_id, alias_type, alias_value),
            )
        return paper_id, True

    paper_id = int(existing["id"])
    connection.execute(
        """
        UPDATE papers SET
            external_id = CASE WHEN external_id = '' THEN ? ELSE external_id END,
            doi = COALESCE(doi, ?),
            arxiv_id = COALESCE(arxiv_id, ?),
            abstract = CASE WHEN abstract = '' THEN ? ELSE abstract END,
            authors_json = CASE WHEN authors_json = '[]' THEN ? ELSE authors_json END,
            publication_year = COALESCE(publication_year, ?),
            venue = CASE WHEN venue = '' THEN ? ELSE venue END,
            url = CASE WHEN url = '' THEN ? ELSE url END,
            pdf_url = CASE WHEN pdf_url = '' THEN ? ELSE pdf_url END,
            updated_at = ?
        WHERE id = ?
        """,
        (
            paper.external_id,
            clean_doi or None,
            clean_arxiv or None,
            paper.abstract.strip(),
            json.dumps(paper.authors, ensure_ascii=False),
            paper.publication_year,
            paper.venue.strip(),
            paper.url.strip(),
            paper.pdf_url.strip(),
            timestamp,
            paper_id,
        ),
    )
    for alias_type, alias_value in aliases:
        connection.execute(
            """
            INSERT OR IGNORE INTO paper_aliases(paper_id, alias_type, alias_value)
            VALUES (?, ?, ?)
            """,
            (paper_id, alias_type, alias_value),
        )
    return paper_id, False


def _has_row(connection: sqlite3.Connection, table: str, paper_id: int) -> bool:
    allowed = {
        "decisions",
        "evidence",
        "paper_analysis",
        "paper_documents",
        "screening_events",
    }
    if table not in allowed:
        raise ValueError("Unsupported table")
    return (
        connection.execute(
            f"SELECT 1 FROM {table} WHERE paper_id=? LIMIT 1",  # noqa: S608
            (paper_id,),
        ).fetchone()
        is not None
    )


def deduplicate_by_normalized_title(connection: sqlite3.Connection) -> int:
    """Merge safe normalized-title duplicates while preserving identifier aliases."""

    rows = list(connection.execute("SELECT * FROM papers ORDER BY id"))
    groups: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        groups.setdefault(normalize_title(row["title"]), []).append(row)
    merged_count = 0
    for group in groups.values():
        if len(group) < 2:
            continue
        if any(
            _strong_identifiers_conflict(
                left["doi"], left["arxiv_id"], right["doi"], right["arxiv_id"]
            )
            for index, left in enumerate(group)
            for right in group[index + 1 :]
        ):
            # Same titles with conflicting strong identifiers require a human decision.
            continue
        active = [
            row
            for row in group
            if row["status"] != "identified"
            or any(
                _has_row(connection, table, int(row["id"]))
                for table in (
                    "screening_events",
                    "decisions",
                    "paper_analysis",
                    "paper_documents",
                    "evidence",
                )
            )
        ]
        # Conflicting reviewed versions need a human choice, not an automatic merge.
        if len(active) > 1:
            continue
        target = active[0] if active else group[0]
        target_id = int(target["id"])
        for source in (row for row in group if int(row["id"]) != target_id):
            source_id = int(source["id"])
            source_aliases = list(
                connection.execute(
                    "SELECT alias_type, alias_value FROM paper_aliases WHERE paper_id=?",
                    (source_id,),
                )
            )
            for alias in source_aliases:
                connection.execute(
                    """
                    INSERT INTO paper_aliases(paper_id, alias_type, alias_value)
                    VALUES (?, ?, ?)
                    ON CONFLICT(alias_type, alias_value) DO UPDATE SET paper_id=excluded.paper_id
                    """,
                    (target_id, alias["alias_type"], alias["alias_value"]),
                )
            for alias_type, alias_value in (
                ("canonical", source["canonical_key"]),
                ("doi", source["doi"] or ""),
                ("arxiv", source["arxiv_id"] or ""),
                (f"external:{source['source'].casefold()}", source["external_id"] or ""),
            ):
                if alias_value:
                    connection.execute(
                        """
                        INSERT OR IGNORE INTO paper_aliases(paper_id, alias_type, alias_value)
                        VALUES (?, ?, ?)
                        """,
                        (target_id, alias_type, alias_value),
                    )
            connection.execute(
                """
                INSERT OR IGNORE INTO paper_hits(run_id, paper_id, source_rank)
                SELECT run_id, ?, source_rank FROM paper_hits WHERE paper_id=?
                """,
                (target_id, source_id),
            )
            connection.execute("DELETE FROM paper_hits WHERE paper_id=?", (source_id,))
            for table in ("screening_events", "decisions", "evidence"):
                connection.execute(
                    f"UPDATE {table} SET paper_id=? WHERE paper_id=?",  # noqa: S608
                    (target_id, source_id),
                )
            connection.execute(
                "UPDATE vocabulary SET source_paper_id=? WHERE source_paper_id=?",
                (target_id, source_id),
            )
            for table in ("paper_analysis", "paper_documents"):
                if _has_row(connection, table, source_id) and not _has_row(
                    connection, table, target_id
                ):
                    connection.execute(
                        f"UPDATE {table} SET paper_id=? WHERE paper_id=?",  # noqa: S608
                        (target_id, source_id),
                    )
            connection.execute(
                """
                UPDATE papers SET
                    doi=COALESCE(doi, ?),
                    arxiv_id=COALESCE(arxiv_id, ?),
                    abstract=CASE WHEN abstract='' THEN ? ELSE abstract END,
                    authors_json=CASE WHEN authors_json='[]' THEN ? ELSE authors_json END,
                    publication_year=COALESCE(publication_year, ?),
                    venue=CASE WHEN venue='' THEN ? ELSE venue END,
                    url=CASE WHEN url='' THEN ? ELSE url END,
                    pdf_url=CASE WHEN pdf_url='' THEN ? ELSE pdf_url END,
                    updated_at=?
                WHERE id=?
                """,
                (
                    source["doi"],
                    source["arxiv_id"],
                    source["abstract"],
                    source["authors_json"],
                    source["publication_year"],
                    source["venue"],
                    source["url"],
                    source["pdf_url"],
                    utc_now(),
                    target_id,
                ),
            )
            connection.execute("DELETE FROM papers WHERE id=?", (source_id,))
            merged_count += 1
    return merged_count


def duplicate_title_groups(connection: sqlite3.Connection) -> list[list[sqlite3.Row]]:
    """Return exact normalized-title groups for a human preview."""

    groups: dict[str, list[sqlite3.Row]] = {}
    for row in connection.execute("SELECT * FROM papers ORDER BY id"):
        groups.setdefault(normalize_title(row["title"]), []).append(row)
    return [group for group in groups.values() if len(group) > 1]


def seed_library(
    connection: sqlite3.Connection,
    papers_path: Path,
    vocabulary_path: Path,
) -> dict[str, int]:
    papers_data = json.loads(papers_path.read_text(encoding="utf-8"))
    vocabulary_data = json.loads(vocabulary_path.read_text(encoding="utf-8"))
    timestamp = utc_now()
    existing_run = connection.execute(
        """
        SELECT id FROM search_runs
        WHERE source='curated_seed' AND query='initial mini-project bibliography'
        ORDER BY id LIMIT 1
        """
    ).fetchone()
    run_was_created = existing_run is None
    if existing_run:
        run_id = int(existing_run["id"])
        connection.execute(
            """
            UPDATE search_runs
            SET finished_at=?, returned_count=?, status='ok', error=''
            WHERE id=?
            """,
            (timestamp, len(papers_data), run_id),
        )
    else:
        cursor = connection.execute(
            """
            INSERT INTO search_runs(
                source, query, started_at, finished_at, returned_count, inserted_count, status
            ) VALUES ('curated_seed', 'initial mini-project bibliography', ?, ?, ?, 0, 'ok')
            """,
            (timestamp, timestamp, len(papers_data)),
        )
        run_id = int(cursor.lastrowid)
    connection.execute(
        """
        INSERT INTO search_run_details(
            run_id, executed_query, request_url, run_kind
        ) VALUES (?, 'initial mini-project bibliography', 'manual-curation', 'pilot')
        ON CONFLICT(run_id) DO UPDATE SET
            executed_query=excluded.executed_query,
            request_url=excluded.request_url,
            run_kind='pilot'
        """,
        (run_id,),
    )
    inserted = 0
    for rank, raw in enumerate(papers_data, start=1):
        paper = PaperRecord.from_mapping(raw)
        paper_id, was_inserted = upsert_paper(connection, paper)
        inserted += int(was_inserted)
        if not was_inserted:
            human_activity = connection.execute(
                """
                SELECT
                    EXISTS(SELECT 1 FROM screening_events WHERE paper_id=?) OR
                    EXISTS(SELECT 1 FROM decisions WHERE paper_id=?) AS present
                """,
                (paper_id, paper_id),
            ).fetchone()["present"]
            if not human_activity:
                connection.execute(
                    """
                    UPDATE papers
                    SET status=?, exclusion_code=?, screening_reason=?, updated_at=?
                    WHERE id=?
                    """,
                    (
                        paper.status,
                        paper.exclusion_code,
                        paper.screening_reason,
                        timestamp,
                        paper_id,
                    ),
                )
        connection.execute(
            "INSERT OR IGNORE INTO paper_hits(run_id, paper_id, source_rank) VALUES (?, ?, ?)",
            (run_id, paper_id, rank),
        )
    if run_was_created:
        connection.execute(
            "UPDATE search_runs SET inserted_count = ? WHERE id = ?", (inserted, run_id)
        )

    vocabulary_inserted = 0
    for word in vocabulary_data:
        result = connection.execute(
            """
            INSERT OR IGNORE INTO vocabulary(
                term, translation_fr, definition_en, synonyms_json, example_en,
                due_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                word["term"],
                word["translation_fr"],
                word["definition_en"],
                json.dumps(word.get("synonyms", []), ensure_ascii=False),
                word["example_en"],
                timestamp,
                timestamp,
            ),
        )
        vocabulary_inserted += max(result.rowcount, 0)
    return {"papers": inserted, "vocabulary": vocabulary_inserted}


def list_papers(
    connection: sqlite3.Connection,
    *,
    status: str | None = None,
    limit: int = 50,
) -> list[sqlite3.Row]:
    if status:
        return list(
            connection.execute(
                """
                SELECT * FROM papers
                WHERE status = ?
                ORDER BY publication_year DESC, title LIMIT ?
                """,
                (status, limit),
            )
        )
    return list(
        connection.execute(
            "SELECT * FROM papers ORDER BY publication_year DESC, title LIMIT ?", (limit,)
        )
    )


def record_hits(
    connection: sqlite3.Connection,
    run_id: int,
    papers: Iterable[PaperRecord],
) -> tuple[int, int]:
    returned = 0
    inserted = 0
    for rank, paper in enumerate(papers, start=1):
        returned += 1
        paper_id, was_inserted = upsert_paper(connection, paper)
        inserted += int(was_inserted)
        connection.execute(
            "INSERT OR IGNORE INTO paper_hits(run_id, paper_id, source_rank) VALUES (?, ?, ?)",
            (run_id, paper_id, rank),
        )
    return returned, inserted
