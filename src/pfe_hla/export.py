"""Export a secret-free snapshot consumed by the static dashboard."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from pfe_hla.library import utc_now
from pfe_hla.prisma import compute_prisma_counts


def _json_list(raw: str) -> list[str]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return value if isinstance(value, list) else []


def _public_paper_analysis(row: sqlite3.Row) -> dict | None:
    verification_status = row["analysis_verification_status"]
    if verification_status is None:
        return None

    verified = verification_status == "verified"
    analysis: dict = {
        "verification_status": verification_status,
        "verified": verified,
    }
    if not verified:
        return analysis

    analysis.update(
        {
            "access_regime": row["analysis_access_regime"],
            "attack_level": row["analysis_attack_level"],
            "importance_method": row["analysis_importance_method"],
            "search_method": row["analysis_search_method"],
            "perturbation_space": row["analysis_perturbation_space"],
            "constraints": row["analysis_constraints_text"],
            "datasets": row["analysis_datasets_text"],
            "models": row["analysis_models_text"],
            "query_budget": row["analysis_query_budget_text"],
            "metrics": row["analysis_metrics_text"],
            "evidence": _json_list(row["analysis_evidence_json"]),
        }
    )
    return analysis


def build_public_state(connection: sqlite3.Connection) -> dict:
    papers = []
    for row in connection.execute(
        """
        SELECT papers.id, papers.title, papers.abstract, papers.authors_json,
               papers.publication_year, papers.venue, papers.url, papers.pdf_url,
               papers.status, papers.exclusion_code, papers.source,
               EXISTS (
                   SELECT 1
                   FROM paper_hits
                   JOIN search_runs ON search_runs.id=paper_hits.run_id
                   JOIN search_run_details ON search_run_details.run_id=search_runs.id
                   WHERE paper_hits.paper_id=papers.id
                     AND search_runs.status='ok'
                     AND search_run_details.run_kind='review'
               ) AS in_formal_review,
               paper_analysis.verification_status AS analysis_verification_status,
               paper_analysis.access_regime AS analysis_access_regime,
               paper_analysis.attack_level AS analysis_attack_level,
               paper_analysis.importance_method AS analysis_importance_method,
               paper_analysis.search_method AS analysis_search_method,
               paper_analysis.perturbation_space AS analysis_perturbation_space,
               paper_analysis.constraints_text AS analysis_constraints_text,
               paper_analysis.datasets_text AS analysis_datasets_text,
               paper_analysis.models_text AS analysis_models_text,
               paper_analysis.query_budget_text AS analysis_query_budget_text,
               paper_analysis.metrics_text AS analysis_metrics_text,
               paper_analysis.evidence_json AS analysis_evidence_json
        FROM papers
        LEFT JOIN paper_analysis ON paper_analysis.paper_id=papers.id
        ORDER BY papers.publication_year DESC, papers.title
        """
    ):
        papers.append(
            {
                "id": row["id"],
                "title": row["title"],
                "abstract": row["abstract"],
                "authors": _json_list(row["authors_json"]),
                "year": row["publication_year"],
                "venue": row["venue"],
                "url": row["url"],
                "pdfUrl": row["pdf_url"],
                "status": row["status"],
                "exclusionCode": row["exclusion_code"],
                "source": row["source"],
                "inFormalReview": bool(row["in_formal_review"]),
                "paper_analysis": _public_paper_analysis(row),
            }
        )
    vocabulary = []
    for row in connection.execute(
        """
        SELECT id, term, translation_fr, definition_en, synonyms_json, example_en,
               repetitions, interval_days, due_at
        FROM vocabulary ORDER BY term
        """
    ):
        vocabulary.append(
            {
                "id": row["id"],
                "term": row["term"],
                "translation": row["translation_fr"],
                "definition": row["definition_en"],
                "synonyms": _json_list(row["synonyms_json"]),
                "example": row["example_en"],
                "repetitions": row["repetitions"],
                "intervalDays": row["interval_days"],
                "dueAt": row["due_at"],
            }
        )
    experiments = [
        {
            "id": row["id"],
            "name": row["run_name"],
            "method": row["method"],
            "dataset": row["dataset"],
            "model": row["model"],
            "seed": row["seed"],
            "metrics": json.loads(row["metrics_json"]),
            "status": "completed",
            "createdAt": row["created_at"],
            "completedAt": row["created_at"],
        }
        for row in connection.execute("SELECT * FROM experiments ORDER BY created_at DESC")
    ]
    search_runs = [
        {
            "id": row["id"],
            "source": row["source"],
            "query": row["query"],
            "startedAt": row["started_at"],
            "finishedAt": row["finished_at"],
            "returned": row["returned_count"],
            "inserted": row["inserted_count"],
            "status": row["status"],
            "error": row["error"],
            "runKind": row["run_kind"],
            "executedQuery": row["executed_query"],
            "requestUrl": row["request_url"],
        }
        for row in connection.execute(
            """
            SELECT search_runs.*, search_run_details.run_kind,
                   search_run_details.executed_query, search_run_details.request_url
            FROM search_runs
            JOIN search_run_details ON search_run_details.run_id=search_runs.id
            ORDER BY started_at DESC, id DESC
            """
        )
    ]
    evidence_counts = {
        row["verification_status"]: int(row["n"])
        for row in connection.execute(
            "SELECT verification_status, COUNT(*) AS n FROM evidence GROUP BY verification_status"
        )
    }
    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "prisma": compute_prisma_counts(connection).as_dict(),
        "papers": papers,
        "vocabulary": vocabulary,
        "experiments": experiments,
        "searchRuns": search_runs,
        "evidence": evidence_counts,
    }


def export_public_state(connection: sqlite3.Connection, output_path: Path | str) -> Path:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(build_public_state(connection), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path
