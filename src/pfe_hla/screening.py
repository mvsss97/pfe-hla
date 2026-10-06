"""Transparent title/abstract screening helpers.

Automation returns a suggestion, never a fabricated human decision. Applying a
decision creates an auditable event and updates the paper state.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from pfe_hla.library import utc_now


@dataclass(frozen=True, slots=True)
class ScreeningSuggestion:
    decision: str
    reason_code: str | None
    rationale: str
    confidence: str


TEXT_TERMS = {
    "text",
    "nlp",
    "language",
    "sentence",
    "word",
    "token",
    "classifier",
    "classification",
    "bert",
    "transformer",
}
ATTACK_TERMS = {"adversarial", "attack", "evasion", "robustness", "perturbation"}
HARD_LABEL_TERMS = {
    "hard label",
    "hard-label",
    "decision based",
    "decision-based",
    "label only",
    "label-only",
    "score free",
    "score-free",
}
BLACK_BOX_TERMS = {"black box", "black-box", "query", "queries"}

TITLE_ABSTRACT_EXCLUSION_CODES = frozenset({"E1", "E2", "E3", "E4", "E5", "E8"})
FULL_TEXT_EXCLUSION_CODES = frozenset({"E1", "E2", "E5", "E6", "E7", "E8"})
FINAL_EXCLUSION_CODES = frozenset({"E1", "E2", "E5", "E6", "E8"})


def _require_formal_review_paper(
    connection: sqlite3.Connection, paper_id: int
) -> sqlite3.Row:
    paper = connection.execute(
        "SELECT status FROM papers WHERE id=?", (paper_id,)
    ).fetchone()
    if paper is None:
        raise KeyError(f"Unknown paper id {paper_id}")
    formal_hit = connection.execute(
        """
        SELECT 1
        FROM paper_hits
        JOIN search_runs ON search_runs.id=paper_hits.run_id
        JOIN search_run_details ON search_run_details.run_id=search_runs.id
        WHERE paper_hits.paper_id=?
          AND search_runs.status='ok'
          AND search_run_details.run_kind='review'
        LIMIT 1
        """,
        (paper_id,),
    ).fetchone()
    if formal_hit is None:
        raise ValueError(
            "Screening decisions are restricted to the documented formal-review corpus"
        )
    return paper


def suggest_title_abstract_screening(paper: sqlite3.Row) -> ScreeningSuggestion:
    text = f"{paper['title']} {paper['abstract']}".lower()
    year = paper["publication_year"]
    language = (paper["language"] or "").lower()
    if year is not None and year < 2018:
        return ScreeningSuggestion(
            "exclude", "E3", "Published before the protocol window (2018–present).", "high"
        )
    if language and language != "en":
        return ScreeningSuggestion(
            "exclude", "E4", "The protocol currently includes English publications only.", "high"
        )
    if not any(term in text for term in TEXT_TERMS):
        return ScreeningSuggestion(
            "exclude", "E1", "No textual NLP or text-classification signal in metadata.", "medium"
        )
    if not any(term in text for term in ATTACK_TERMS):
        return ScreeningSuggestion(
            "exclude", "E2", "No adversarial-attack or robustness signal in metadata.", "medium"
        )
    if any(term in text for term in HARD_LABEL_TERMS):
        return ScreeningSuggestion(
            "include",
            None,
            "Direct hard-label or decision-based relevance; retrieve the full text.",
            "high",
        )
    if any(term in text for term in BLACK_BOX_TERMS):
        return ScreeningSuggestion(
            "include",
            None,
            "Black-box text attack relevant to the taxonomy or comparison baseline.",
            "medium",
        )
    return ScreeningSuggestion(
        "uncertain",
        None,
        "Relevant text attack, but the access regime must be verified in the full paper.",
        "low",
    )


def apply_screening_decision(
    connection: sqlite3.Connection,
    *,
    paper_id: int,
    stage: str,
    decision: str,
    reason_code: str | None,
    rationale: str,
    reviewer: str = "human",
) -> bool:
    if stage not in {"title_abstract", "full_text"}:
        raise ValueError("stage must be title_abstract or full_text")
    if decision not in {"include", "exclude", "uncertain"}:
        raise ValueError("decision must be include, exclude or uncertain")
    if not rationale.strip():
        raise ValueError("A screening rationale is required")
    allowed_codes = (
        TITLE_ABSTRACT_EXCLUSION_CODES
        if stage == "title_abstract"
        else FULL_TEXT_EXCLUSION_CODES
    )
    if decision == "exclude":
        if reason_code not in allowed_codes:
            allowed = ", ".join(sorted(allowed_codes))
            raise ValueError(f"An exclusion at {stage} requires one of: {allowed}")
    elif reason_code is not None:
        raise ValueError("Only an exclusion may carry an exclusion code")
    paper = _require_formal_review_paper(connection, paper_id)
    latest = connection.execute(
        """
        SELECT decision, reason_code FROM screening_events
        WHERE paper_id=? AND stage=? ORDER BY id DESC LIMIT 1
        """,
        (paper_id, stage),
    ).fetchone()
    if latest and latest["decision"] == decision and latest["reason_code"] == reason_code:
        return False
    allowed_statuses = {
        "title_abstract": {"identified", "screened"},
        "full_text": {"sought"},
    }
    if paper["status"] not in allowed_statuses[stage]:
        raise ValueError(
            f"Cannot apply {stage} screening while paper status is {paper['status']}"
        )
    timestamp = utc_now()
    connection.execute(
        """
        INSERT INTO screening_events(
            paper_id, stage, decision, reason_code, rationale, reviewer, screened_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (paper_id, stage, decision, reason_code, rationale, reviewer, timestamp),
    )
    if decision == "exclude":
        next_status = "excluded"
    elif stage == "title_abstract" and decision == "include":
        next_status = "sought"
    elif stage == "full_text" and decision == "include":
        next_status = "assessed"
    elif stage == "title_abstract":
        next_status = "identified"
    else:
        next_status = "sought"
    connection.execute(
        """
        UPDATE papers
        SET status=?, exclusion_code=?, screening_reason=?, updated_at=?
        WHERE id=?
        """,
        (
            next_status,
            reason_code if decision == "exclude" else None,
            rationale,
            timestamp,
            paper_id,
        ),
    )
    return True


def record_final_decision(
    connection: sqlite3.Connection,
    *,
    paper_id: int,
    decision: str,
    reason_code: str | None = None,
    note: str = "",
    channel: str = "cli",
) -> bool:
    if decision not in {"keep", "reject", "pending"}:
        raise ValueError("decision must be keep, reject or pending")
    if decision == "reject":
        if reason_code not in FINAL_EXCLUSION_CODES:
            allowed = ", ".join(sorted(FINAL_EXCLUSION_CODES))
            raise ValueError(f"A final rejection requires one of: {allowed}")
        if not note.strip():
            raise ValueError("A final rejection note is required")
    elif reason_code is not None:
        raise ValueError("Only a rejection may carry an exclusion code")
    paper = _require_formal_review_paper(connection, paper_id)
    latest = connection.execute(
        """
        SELECT decision, reason_code FROM decisions
        WHERE paper_id=? ORDER BY id DESC LIMIT 1
        """,
        (paper_id,),
    ).fetchone()
    if latest and latest["decision"] == decision and latest["reason_code"] == reason_code:
        return False
    if paper["status"] != "assessed":
        raise ValueError(
            f"A final decision requires an assessed paper, not {paper['status']}"
        )
    timestamp = utc_now()
    connection.execute(
        """
        INSERT INTO decisions(paper_id, decision, reason_code, note, channel, decided_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (paper_id, decision, reason_code, note, channel, timestamp),
    )
    if decision == "keep":
        status = "included"
    elif decision == "reject":
        status = "excluded"
    else:
        status = "assessed"
    connection.execute(
        "UPDATE papers SET status=?, exclusion_code=?, updated_at=? WHERE id=?",
        (status, reason_code if decision == "reject" else None, timestamp, paper_id),
    )
    return True


def reopen_paper(
    connection: sqlite3.Connection,
    *,
    paper_id: int,
    target_status: str,
    rationale: str,
    reviewer: str = "human",
) -> None:
    """Reopen a decision without deleting history or falsifying prior counts."""

    if target_status not in {"identified", "sought", "assessed"}:
        raise ValueError("target_status must be identified, sought or assessed")
    if not rationale.strip():
        raise ValueError("A reopening rationale is required")
    paper = _require_formal_review_paper(connection, paper_id)
    timestamp = utc_now()
    title_decision = "uncertain" if target_status == "identified" else "include"
    connection.execute(
        """
        INSERT INTO screening_events(
            paper_id, stage, decision, reason_code, rationale, reviewer, screened_at
        ) VALUES (?, 'title_abstract', ?, NULL, ?, ?, ?)
        """,
        (
            paper_id,
            title_decision,
            f"REOPEN {paper['status']} → {target_status}: {rationale.strip()}",
            reviewer,
            timestamp,
        ),
    )
    if target_status in {"identified", "sought"}:
        connection.execute(
            """
            INSERT INTO screening_events(
                paper_id, stage, decision, reason_code, rationale, reviewer, screened_at
            ) VALUES (?, 'full_text', 'uncertain', NULL, ?, ?, ?)
            """,
            (paper_id, f"REOPEN: {rationale.strip()}", reviewer, timestamp),
        )
    else:
        connection.execute(
            """
            INSERT INTO screening_events(
                paper_id, stage, decision, reason_code, rationale, reviewer, screened_at
            ) VALUES (?, 'full_text', 'include', NULL, ?, ?, ?)
            """,
            (paper_id, f"REOPEN: {rationale.strip()}", reviewer, timestamp),
        )
    connection.execute(
        """
        INSERT INTO decisions(paper_id, decision, note, channel, decided_at)
        VALUES (?, 'pending', ?, 'amendment', ?)
        """,
        (paper_id, f"REOPEN: {rationale.strip()}", timestamp),
    )
    connection.execute(
        """
        UPDATE papers
        SET status=?, exclusion_code=NULL, screening_reason=?, updated_at=?
        WHERE id=?
        """,
        (target_status, rationale.strip(), timestamp, paper_id),
    )
