"""Secure PDF retrieval, text extraction and lexical evidence checks.

Finding a quote proves only that the string occurs in the document. It does not
prove that a claim interprets the right dataset, table column or protocol; that
context remains a human review step.
"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import unicodedata
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from pfe_hla.collect import _verified_ssl_context
from pfe_hla.library import utc_now

MAX_PDF_BYTES = 50 * 1024 * 1024
PAGE_MARKER = "<<<PAGE {number}>>>"


@dataclass(frozen=True, slots=True)
class ExtractedDocument:
    paper_id: int
    pdf_path: Path
    text_path: Path
    sha256: str
    page_count: int
    character_count: int


@dataclass(frozen=True, slots=True)
class EvidenceMatch:
    status: str
    page_number: int | None
    context: str


def _safe_pdf_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("PDF URL must use HTTPS and include a hostname")
    return value


def download_pdf(url: str, destination: Path, *, max_bytes: int = MAX_PDF_BYTES) -> str:
    """Download one HTTPS PDF atomically and return its SHA-256 digest."""

    _safe_pdf_url(url)
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/pdf,application/octet-stream;q=0.8",
            "User-Agent": "PFE-HLA/0.1 full-text research client",
        },
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    digest = hashlib.sha256()
    size = 0
    try:
        with urllib.request.urlopen(  # noqa: S310
            request, timeout=60, context=_verified_ssl_context()
        ) as response:
            _safe_pdf_url(response.geturl())
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > max_bytes:
                raise ValueError(f"PDF exceeds the {max_bytes}-byte limit")
            first_chunk = response.read(min(64 * 1024, max_bytes + 1))
            if not first_chunk.startswith(b"%PDF-"):
                raise ValueError("Downloaded resource is not a PDF")
            with temporary.open("wb") as output:
                for chunk in (first_chunk,):
                    size += len(chunk)
                    digest.update(chunk)
                    output.write(chunk)
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise ValueError(f"PDF exceeds the {max_bytes}-byte limit")
                    digest.update(chunk)
                    output.write(chunk)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return digest.hexdigest()


def extract_pdf_text(pdf_path: Path, text_path: Path) -> tuple[int, int]:
    """Extract every page with PyMuPDF while preserving page boundaries."""

    try:
        import pymupdf
    except ImportError as exc:  # pragma: no cover - depends on optional extra
        raise RuntimeError('PDF extraction requires: pip install -e ".[review]"') from exc

    pages: list[str] = []
    with pymupdf.open(pdf_path) as document:
        for number, page in enumerate(document, start=1):
            pages.append(f"{PAGE_MARKER.format(number=number)}\n{page.get_text('text')}")
    output = "\n\n".join(pages)
    text_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = text_path.with_suffix(text_path.suffix + ".part")
    try:
        temporary.write_text(output, encoding="utf-8")
        os.replace(temporary, text_path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return len(pages), len(output)


def fetch_and_extract(
    connection: sqlite3.Connection,
    *,
    paper_id: int,
    storage_root: Path,
) -> ExtractedDocument:
    paper = connection.execute(
        "SELECT title, pdf_url, url FROM papers WHERE id=?", (paper_id,)
    ).fetchone()
    if paper is None:
        raise KeyError(f"Unknown paper id {paper_id}")
    pdf_url = paper["pdf_url"] or (paper["url"] if str(paper["url"]).endswith(".pdf") else "")
    if not pdf_url:
        raise ValueError("No direct PDF URL is recorded for this paper")
    pdf_path = storage_root / "pdfs" / f"paper-{paper_id}.pdf"
    text_path = storage_root / "raw" / f"paper-{paper_id}.txt"
    try:
        digest = download_pdf(pdf_url, pdf_path)
        page_count, character_count = extract_pdf_text(pdf_path, text_path)
        connection.execute(
            """
            INSERT INTO paper_documents(
                paper_id, pdf_path, text_path, sha256, page_count, character_count,
                extraction_status, error, extracted_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'extracted', '', ?)
            ON CONFLICT(paper_id) DO UPDATE SET
                pdf_path=excluded.pdf_path,
                text_path=excluded.text_path,
                sha256=excluded.sha256,
                page_count=excluded.page_count,
                character_count=excluded.character_count,
                extraction_status='extracted',
                error='',
                extracted_at=excluded.extracted_at
            """,
            (
                paper_id,
                str(pdf_path),
                str(text_path),
                digest,
                page_count,
                character_count,
                utc_now(),
            ),
        )
    except Exception as exc:
        connection.execute(
            """
            INSERT INTO paper_documents(
                paper_id, pdf_path, text_path, sha256, page_count, character_count,
                extraction_status, error, extracted_at
            ) VALUES (?, ?, ?, '', 0, 0, 'error', ?, ?)
            ON CONFLICT(paper_id) DO UPDATE SET
                extraction_status='error', error=excluded.error,
                extracted_at=excluded.extracted_at
            """,
            (
                paper_id,
                str(pdf_path),
                str(text_path),
                f"{type(exc).__name__}: {exc}"[:500],
                utc_now(),
            ),
        )
        raise
    return ExtractedDocument(
        paper_id=paper_id,
        pdf_path=pdf_path,
        text_path=text_path,
        sha256=digest,
        page_count=page_count,
        character_count=character_count,
    )


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).replace("\u00ad", "")
    value = re.sub(r"-\s*\n\s*", "", value)
    return " ".join(value.casefold().split())


def _context(text: str, needle: str, *, radius: int = 180) -> str:
    normalized = normalize_text(text)
    index = normalized.find(needle)
    if index < 0:
        return ""
    start = max(0, index - radius)
    end = min(len(normalized), index + len(needle) + radius)
    return normalized[start:end]


def verify_evidence_in_pages(
    pages: list[str],
    *,
    quote: str = "",
    value_text: str = "",
) -> EvidenceMatch:
    """Check an exact normalized quote, then a value-only fallback."""

    normalized_quote = normalize_text(quote)
    normalized_value = normalize_text(value_text)
    if not normalized_quote and not normalized_value:
        raise ValueError("quote or value_text is required")
    if normalized_quote:
        for number, page in enumerate(pages, start=1):
            if normalized_quote in normalize_text(page):
                return EvidenceMatch("exact_quote", number, _context(page, normalized_quote))
    if normalized_value:
        for number, page in enumerate(pages, start=1):
            if normalized_value in normalize_text(page):
                return EvidenceMatch("value_only", number, _context(page, normalized_value))
    return EvidenceMatch("not_found", None, "")


def load_extracted_pages(text_path: Path) -> list[str]:
    content = text_path.read_text(encoding="utf-8")
    chunks = re.split(r"<<<PAGE \d+>>>\n", content)
    return [chunk for chunk in chunks if chunk]


def verify_and_record_evidence(
    connection: sqlite3.Connection,
    *,
    paper_id: int,
    claim: str,
    quote: str = "",
    value_text: str = "",
) -> EvidenceMatch:
    document = connection.execute(
        "SELECT text_path FROM paper_documents WHERE paper_id=? AND extraction_status='extracted'",
        (paper_id,),
    ).fetchone()
    if document is None:
        raise ValueError("Extract the paper before checking evidence")
    match = verify_evidence_in_pages(
        load_extracted_pages(Path(document["text_path"])),
        quote=quote,
        value_text=value_text,
    )
    connection.execute(
        """
        INSERT INTO evidence(
            paper_id, claim, quote, value_text, page_number,
            verification_status, context, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            paper_id,
            claim,
            quote,
            value_text,
            match.page_number,
            match.status,
            match.context,
            utc_now(),
        ),
    )
    return match
