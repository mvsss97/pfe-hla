"""Reproducible metadata collection from arXiv and OpenAlex.

The collector stores every search execution and every paper hit so that PRISMA
counts can be reconstructed instead of being typed by hand.
"""

from __future__ import annotations

import json
import re
import sqlite3
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from dataclasses import dataclass
from functools import lru_cache

import certifi

from pfe_hla.library import PaperRecord, record_hits, utc_now

DEFAULT_QUERIES = (
    '"hard label" adversarial text attack',
    '"decision based" adversarial attack NLP',
    'black box adversarial text classification',
    'word importance ranking adversarial text',
)

OPENALEX_SELECT_FIELDS = (
    "id",
    "doi",
    "display_name",
    "publication_year",
    "authorships",
    "primary_location",
    "best_oa_location",
    "abstract_inverted_index",
    "language",
)
ARXIV_MIN_INTERVAL_SECONDS = 3.0
RETRYABLE_HTTP_STATUS = frozenset({429, 500, 502, 503, 504})


@dataclass(frozen=True, slots=True)
class CollectionResult:
    source: str
    query: str
    returned: int
    inserted: int
    run_kind: str
    error: str = ""
    skipped: bool = False


def _looks_like_topic(paper: PaperRecord) -> bool:
    text = f"{paper.title} {paper.abstract}".casefold()
    attack_signal = any(
        term in text for term in ("adversarial", "attack", "robustness", "evasion")
    )
    text_signal = any(
        term in text
        for term in ("text", "language", "nlp", "word", "token", "classifier")
    )
    return attack_signal and text_signal


@lru_cache(maxsize=1)
def _verified_ssl_context() -> ssl.SSLContext:
    """Use Python's CA bundle plus the Windows certificate stores when available."""

    context = ssl.create_default_context(cafile=certifi.where())
    enumerate_certificates = getattr(ssl, "enum_certificates", None)
    if enumerate_certificates is None:
        return context
    for store_name in ("ROOT", "CA"):
        try:
            certificates = enumerate_certificates(store_name)
        except OSError:
            continue
        for certificate, encoding, _trust in certificates:
            if encoding != "x509_asn":
                continue
            try:
                context.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(certificate))
            except ssl.SSLError:
                continue
    return context


def _request_json(url: str, *, user_agent: str, headers: dict[str, str] | None = None) -> dict:
    request_headers = {"Accept": "application/json", "User-Agent": user_agent}
    request_headers.update(headers or {})
    request = urllib.request.Request(url, headers=request_headers)
    with urllib.request.urlopen(  # noqa: S310
        request, timeout=30, context=_verified_ssl_context()
    ) as response:
        return json.loads(response.read().decode("utf-8"))


def _request_xml(url: str, *, user_agent: str) -> ET.Element:
    request = urllib.request.Request(url, headers={"User-Agent": user_agent})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(  # noqa: S310
                request, timeout=30, context=_verified_ssl_context()
            ) as response:
                return ET.fromstring(response.read())  # noqa: S314
        except urllib.error.HTTPError as exc:
            if exc.code not in RETRYABLE_HTTP_STATUS or attempt == 2:
                raise
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            try:
                requested_delay = float(retry_after) if retry_after else 0.0
            except ValueError:
                requested_delay = 0.0
            time.sleep(max(ARXIV_MIN_INTERVAL_SECONDS, requested_delay, 2**attempt))
    raise RuntimeError("unreachable")


def _rebuild_openalex_abstract(index: dict[str, list[int]] | None) -> str:
    if not index:
        return ""
    positions: list[tuple[int, str]] = []
    for word, indices in index.items():
        positions.extend((position, word) for position in indices)
    return " ".join(word for _, word in sorted(positions))


def _openalex_request_url(query: str, *, limit: int) -> str:
    params = {
        "search": query,
        "per-page": str(min(max(limit, 1), 100)),
        "select": ",".join(OPENALEX_SELECT_FIELDS),
    }
    return "https://api.openalex.org/works?" + urllib.parse.urlencode(params)


def search_openalex(query: str, *, email: str | None = None, limit: int = 25) -> list[PaperRecord]:
    # Contact information belongs in the user agent, not in the persisted/public URL.
    url = _openalex_request_url(query, limit=limit)
    user_agent = f"PFE-HLA/0.1 ({email or 'no-contact-configured'})"
    payload = _request_json(url, user_agent=user_agent)
    records: list[PaperRecord] = []
    for work in payload.get("results", []):
        title = (work.get("display_name") or "").strip()
        if not title:
            continue
        primary = work.get("primary_location") or {}
        oa = work.get("best_oa_location") or {}
        source = primary.get("source") or {}
        authors = [
            authorship.get("author", {}).get("display_name", "")
            for authorship in work.get("authorships", [])
        ]
        records.append(
            PaperRecord(
                source="OpenAlex",
                external_id=(work.get("id") or "").rsplit("/", 1)[-1],
                doi=work.get("doi") or "",
                title=title,
                abstract=_rebuild_openalex_abstract(work.get("abstract_inverted_index")),
                authors=[author for author in authors if author],
                publication_year=work.get("publication_year"),
                venue=source.get("display_name") or "",
                language=work.get("language") or "en",
                url=primary.get("landing_page_url") or work.get("doi") or "",
                pdf_url=oa.get("pdf_url") or "",
            )
        )
    return records


def _arxiv_expression(query: str) -> str:
    terms = [phrase or word for phrase, word in re.findall(r'"([^"]+)"|([\w-]+)', query)]
    return " AND ".join(
        f'all:"{term}"' if " " in term else f"all:{term}" for term in terms
    )


def _arxiv_request_url(query: str, *, limit: int) -> str:
    expression = _arxiv_expression(query)
    params = {
        "search_query": expression or f'all:"{query}"',
        "start": "0",
        "max_results": str(min(max(limit, 1), 100)),
        "sortBy": "relevance",
        "sortOrder": "descending",
    }
    return "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(params)


def search_arxiv(query: str, *, limit: int = 25) -> list[PaperRecord]:
    url = _arxiv_request_url(query, limit=limit)
    root = _request_xml(url, user_agent="PFE-HLA/0.1 research collector")
    atom = "{http://www.w3.org/2005/Atom}"
    arxiv = "{http://arxiv.org/schemas/atom}"
    records: list[PaperRecord] = []
    for entry in root.findall(f"{atom}entry"):
        identifier = (entry.findtext(f"{atom}id") or "").rsplit("/", 1)[-1]
        title = " ".join((entry.findtext(f"{atom}title") or "").split())
        if not title:
            continue
        published = entry.findtext(f"{atom}published") or ""
        doi = entry.findtext(f"{arxiv}doi") or ""
        links = {
            link.attrib.get("title", link.attrib.get("rel", "")): link.attrib.get("href", "")
            for link in entry.findall(f"{atom}link")
        }
        records.append(
            PaperRecord(
                source="arXiv",
                external_id=identifier,
                arxiv_id=identifier,
                doi=doi,
                title=title,
                abstract=" ".join((entry.findtext(f"{atom}summary") or "").split()),
                authors=[
                    author.findtext(f"{atom}name") or ""
                    for author in entry.findall(f"{atom}author")
                ],
                publication_year=int(published[:4]) if published[:4].isdigit() else None,
                venue=entry.findtext(f"{arxiv}journal_ref") or "arXiv",
                url=links.get("alternate", f"https://arxiv.org/abs/{identifier}"),
                pdf_url=links.get("pdf", f"https://arxiv.org/pdf/{identifier}"),
            )
        )
    return records


def _collect_one(
    connection: sqlite3.Connection,
    source: str,
    query: str,
    fetcher,
    *,
    executed_query: str,
    request_url: str,
    run_kind: str,
) -> CollectionResult:
    if run_kind == "review":
        existing_review = connection.execute(
            """
            SELECT 1 FROM search_runs
            JOIN search_run_details ON search_run_details.run_id=search_runs.id
            WHERE search_runs.source=? AND search_runs.status='ok'
              AND search_run_details.executed_query=?
              AND search_run_details.request_url=?
              AND search_run_details.run_kind='review'
            LIMIT 1
            """,
            (source, executed_query, request_url),
        ).fetchone()
        if existing_review is not None:
            return CollectionResult(source, query, 0, 0, run_kind, skipped=True)
    started = utc_now()
    cursor = connection.execute(
        "INSERT INTO search_runs(source, query, started_at) VALUES (?, ?, ?)",
        (source, query, started),
    )
    run_id = int(cursor.lastrowid)
    connection.execute(
        """
        INSERT INTO search_run_details(run_id, executed_query, request_url, run_kind)
        VALUES (?, ?, ?, ?)
        """,
        (run_id, executed_query, request_url, run_kind),
    )
    try:
        records = fetcher(query)
        if records and not any(_looks_like_topic(record) for record in records):
            raise ValueError(
                "Query smoke check failed: no result contains both attack and textual-NLP signals"
            )
        returned, inserted = record_hits(connection, run_id, records)
        connection.execute(
            """
            UPDATE search_runs SET finished_at=?, returned_count=?, inserted_count=?, status='ok'
            WHERE id=?
            """,
            (utc_now(), returned, inserted, run_id),
        )
        return CollectionResult(source, query, returned, inserted, run_kind)
    except (OSError, ValueError, ET.ParseError, urllib.error.URLError) as exc:
        error = f"{type(exc).__name__}: {exc}"[:500]
        connection.execute(
            "UPDATE search_runs SET finished_at=?, status='error', error=? WHERE id=?",
            (utc_now(), error, run_id),
        )
        return CollectionResult(source, query, 0, 0, run_kind, error)


def collect_sources(
    connection: sqlite3.Connection,
    *,
    queries: tuple[str, ...] = DEFAULT_QUERIES,
    openalex_email: str | None = None,
    sources: tuple[str, ...] = ("openalex", "arxiv"),
    limit: int = 25,
    run_kind: str = "pilot",
) -> Iterator[CollectionResult]:
    if run_kind not in {"review", "pilot", "watch"}:
        raise ValueError("run_kind must be review, pilot or watch")
    last_arxiv_request_at: float | None = None
    for query in queries:
        if "openalex" in sources:
            yield _collect_one(
                connection,
                "OpenAlex",
                query,
                lambda value: search_openalex(value, email=openalex_email, limit=limit),
                executed_query=query,
                request_url=_openalex_request_url(query, limit=limit),
                run_kind=run_kind,
            )
        if "arxiv" in sources:
            if last_arxiv_request_at is not None:
                elapsed = time.monotonic() - last_arxiv_request_at
                if elapsed < ARXIV_MIN_INTERVAL_SECONDS:
                    time.sleep(ARXIV_MIN_INTERVAL_SECONDS - elapsed)
            last_arxiv_request_at = time.monotonic()
            yield _collect_one(
                connection,
                "arXiv",
                query,
                lambda value: search_arxiv(value, limit=limit),
                executed_query=_arxiv_expression(query),
                request_url=_arxiv_request_url(query, limit=limit),
                run_kind=run_kind,
            )


def invalidate_search_run(
    connection: sqlite3.Connection,
    *,
    run_id: int,
    reason: str,
) -> int:
    """Exclude a faulty search run from counts and remove unreferenced notices."""

    if not reason.strip():
        raise ValueError("An invalidation reason is required")
    run = connection.execute("SELECT id FROM search_runs WHERE id=?", (run_id,)).fetchone()
    if run is None:
        raise KeyError(f"Unknown search run {run_id}")
    connection.execute(
        "UPDATE search_runs SET status='error', error=? WHERE id=?",
        (f"INVALIDATED: {reason.strip()}"[:500], run_id),
    )
    connection.execute("DELETE FROM paper_hits WHERE run_id=?", (run_id,))
    cursor = connection.execute(
        """
        DELETE FROM papers
        WHERE NOT EXISTS (SELECT 1 FROM paper_hits WHERE paper_hits.paper_id=papers.id)
          AND NOT EXISTS (
              SELECT 1 FROM screening_events WHERE screening_events.paper_id=papers.id
          )
          AND NOT EXISTS (SELECT 1 FROM decisions WHERE decisions.paper_id=papers.id)
          AND NOT EXISTS (
              SELECT 1 FROM paper_documents WHERE paper_documents.paper_id=papers.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM paper_analysis WHERE paper_analysis.paper_id=papers.id
          )
          AND NOT EXISTS (SELECT 1 FROM evidence WHERE evidence.paper_id=papers.id)
        """
    )
    return max(cursor.rowcount, 0)
