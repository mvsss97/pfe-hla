"""Export a secret-free snapshot consumed by the static dashboard."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from pfe_hla.library import paper_key, utc_now
from pfe_hla.news import recent_news
from pfe_hla.prisma import compute_prisma_counts
from pfe_hla.protocol import active_protocol
from pfe_hla.reading import resolve_pdf_url
from pfe_hla.supervisor import load_families, supervisor_papers

BOT_QUEUE_LIMIT = 40
BOT_SHEETS_LIMIT = 15
BOT_ABSTRACT_CHARS = 600
BOT_NEWS_LIMIT = 30
SITE_NEWS_LIMIT = 200


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


def _latest_ai_screening(connection: sqlite3.Connection) -> dict[int, dict]:
    return {
        int(row["paper_id"]): {
            "decision": row["decision"],
            "code": row["reason_code"],
            "access": row["access_regime"],
            "contribution": row["contribution_type"],
            "relevance": row["relevance"],
            "confidence": round(float(row["confidence"]), 2),
            "rationale": row["rationale"],
            "model": row["model"],
            "at": row["created_at"],
        }
        for row in connection.execute(
            """
            WITH latest AS (SELECT paper_id, MAX(id) AS id FROM ai_screening GROUP BY paper_id)
            SELECT ai.* FROM ai_screening AS ai JOIN latest ON latest.id = ai.id
            """
        )
    }


def _latest_triage(connection: sqlite3.Connection) -> dict[int, dict]:
    return {
        int(row["paper_id"]): {
            "decision": row["decision"],
            "code": row["reason_code"],
            "at": row["decided_at"],
            "carried": row["carried_event_id"] is not None,
        }
        for row in connection.execute(
            """
            WITH latest AS (SELECT paper_id, MAX(id) AS id FROM triage_events GROUP BY paper_id)
            SELECT t.* FROM triage_events AS t JOIN latest ON latest.id = t.id
            """
        )
    }


def _human_title_screened(connection: sqlite3.Connection) -> set[int]:
    return {
        int(row["paper_id"])
        for row in connection.execute(
            "SELECT DISTINCT paper_id FROM screening_events WHERE stage='title_abstract'"
        )
    }


def _reading_queue(connection: sqlite3.Connection) -> dict[int, dict]:
    return {
        int(row["paper_id"]): {
            "priority": row["priority"],
            "reason": row["reason"],
            "attempts": row["attempts"],
            "error": row["last_error"],
            "done": row["done_at"] is not None,
        }
        for row in connection.execute("SELECT * FROM reading_queue")
    }


def _paper_tags(connection: sqlite3.Connection) -> dict[int, list[str]]:
    tags: dict[int, list[str]] = {}
    for row in connection.execute("SELECT paper_id, tag FROM paper_tags ORDER BY tag"):
        tags.setdefault(int(row["paper_id"]), []).append(row["tag"])
    return tags


def _translations(connection: sqlite3.Connection) -> dict[int, sqlite3.Row]:
    return {
        int(row["paper_id"]): row
        for row in connection.execute(
            "SELECT paper_id, title_fr, abstract_fr FROM paper_translations"
        )
    }


def _sheet_index(connection: sqlite3.Connection) -> dict[int, dict]:
    return {
        int(row["paper_id"]): json.loads(row["checks_json"] or "{}").get("summary", {})
        for row in connection.execute("SELECT paper_id, checks_json FROM paper_sheets")
    }


def _protocol_state(connection: sqlite3.Connection) -> dict | None:
    row = active_protocol(connection)
    if row is None:
        return None
    return {
        "version": row["version"],
        "status": row["status"],
        "sha256": row["sha256"],
        "gitCommit": row["git_commit"],
        "frozenAt": row["frozen_at"],
        "note": row["note"],
    }


def _agents_state(connection: sqlite3.Connection) -> dict:
    runs = [
        {
            "task": row["task"],
            "target": row["target"],
            "status": row["status"],
            "model": row["model"],
            "durationMs": row["duration_ms"],
            "costUsd": row["cost_usd"],
            "detail": row["detail"],
            "startedAt": row["started_at"],
        }
        for row in connection.execute(
            "SELECT * FROM agent_runs ORDER BY started_at DESC, id DESC LIMIT 40"
        )
    ]
    totals = {
        row["task"]: {"ok": int(row["ok"]), "error": int(row["error"])}
        for row in connection.execute(
            """
            SELECT task, SUM(status='ok') AS ok, SUM(status='error') AS error
            FROM agent_runs WHERE task != 'pipeline' GROUP BY task
            """
        )
    }
    counts = connection.execute(
        """
        SELECT (SELECT COUNT(DISTINCT paper_id) FROM ai_screening) AS screened,
               (SELECT COUNT(*) FROM paper_sheets) AS sheets,
               (SELECT COUNT(*) FROM synthesis) AS syntheses,
               (SELECT COUNT(*) FROM reading_queue WHERE done_at IS NULL) AS queued,
               (SELECT MAX(started_at) FROM agent_runs WHERE status='ok') AS last_ok
        """
    ).fetchone()
    return {
        "runs": runs,
        "totals": totals,
        "screenedPapers": int(counts["screened"] or 0),
        "sheets": int(counts["sheets"] or 0),
        "syntheses": int(counts["syntheses"] or 0),
        "readingQueue": int(counts["queued"] or 0),
        "lastSuccessAt": counts["last_ok"],
    }


def build_public_state(connection: sqlite3.Connection) -> dict:
    ai_by_paper = _latest_ai_screening(connection)
    triage_by_paper = _latest_triage(connection)
    queue_by_paper = _reading_queue(connection)
    sheets_by_paper = _sheet_index(connection)
    tags_by_paper = _paper_tags(connection)
    translations = _translations(connection)
    papers = []
    for row in connection.execute(
        """
        SELECT papers.id, papers.canonical_key, papers.discovered_at,
               papers.title, papers.abstract, papers.authors_json,
               papers.publication_year, papers.venue, papers.url, papers.pdf_url,
               papers.status, papers.exclusion_code, papers.source,
               papers.arxiv_id, papers.doi,
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
        paper_id = int(row["id"])
        french = translations.get(paper_id)
        papers.append(
            {
                "id": row["id"],
                "key": paper_key(str(row["canonical_key"])),
                "discoveredAt": row["discovered_at"],
                "title": row["title"],
                "titleFr": french["title_fr"] if french else "",
                "abstract": row["abstract"],
                "abstractFr": french["abstract_fr"] if french else "",
                "readerUrl": resolve_pdf_url(row),
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
                "ai": ai_by_paper.get(paper_id),
                "triage": triage_by_paper.get(paper_id),
                "readingQueue": queue_by_paper.get(paper_id),
                "sheet": sheets_by_paper.get(paper_id),
                "tags": tags_by_paper.get(paper_id, []),
            }
        )
    vocabulary = []
    for row in connection.execute(
        """
        SELECT vocabulary.id, term, translation_fr, definition_en, synonyms_json, example_en,
               definition_fr, example_fr,
               repetitions, interval_days, due_at, papers.title AS source_title
        FROM vocabulary LEFT JOIN papers ON papers.id = vocabulary.source_paper_id
        ORDER BY term
        """
    ):
        vocabulary.append(
            {
                "id": row["id"],
                "term": row["term"],
                "translation": row["translation_fr"],
                "definition": row["definition_en"],
                "definitionFr": row["definition_fr"],
                "synonyms": _json_list(row["synonyms_json"]),
                "example": row["example_en"],
                "exampleFr": row["example_fr"],
                "repetitions": row["repetitions"],
                "intervalDays": row["interval_days"],
                "dueAt": row["due_at"],
                "source": row["source_title"],
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
        "schemaVersion": 2,
        "generatedAt": utc_now(),
        "prisma": compute_prisma_counts(connection).as_dict(),
        "protocol": _protocol_state(connection),
        "agents": _agents_state(connection),
        "papers": papers,
        "vocabulary": vocabulary,
        "experiments": experiments,
        "searchRuns": search_runs,
        "evidence": evidence_counts,
        "supervisor": {"families": load_families(), "papers": supervisor_papers(connection)},
    }


def build_sheets_state(connection: sqlite3.Connection) -> dict:
    """AI reading sheets and the latest synthesis, for the Fiches/Comparatif pages."""

    sheets = []
    for row in connection.execute(
        """
        SELECT papers.id, papers.canonical_key, papers.title, papers.authors_json,
               papers.publication_year, papers.venue, papers.url, papers.pdf_url,
               papers.status, paper_sheets.*
        FROM paper_sheets JOIN papers ON papers.id = paper_sheets.paper_id
        ORDER BY paper_sheets.updated_at DESC
        """
    ):
        sheets.append(
            {
                "key": paper_key(str(row["canonical_key"])),
                "paperId": row["paper_id"],
                "title": row["title"],
                "authors": _json_list(row["authors_json"]),
                "year": row["publication_year"],
                "venue": row["venue"],
                "url": row["url"],
                "pdfUrl": row["pdf_url"],
                "status": row["status"],
                "sourceKind": row["source_kind"],
                "documentSha256": row["document_sha256"],
                "model": row["model"],
                "promptVersion": row["prompt_version"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
                "checks": json.loads(row["checks_json"] or "{}"),
                "sheet": json.loads(row["sheet_json"]),
            }
        )
    latest = connection.execute("SELECT * FROM synthesis ORDER BY id DESC LIMIT 1").fetchone()
    synthesis = None
    if latest is not None:
        id_to_key = {
            int(row["id"]): paper_key(str(row["canonical_key"]))
            for row in connection.execute("SELECT id, canonical_key FROM papers")
        }
        synthesis = {
            "createdAt": latest["created_at"],
            "model": latest["model"],
            "promptVersion": latest["prompt_version"],
            "keys": [
                id_to_key[paper_id]
                for paper_id in json.loads(latest["paper_ids_json"] or "[]")
                if paper_id in id_to_key
            ],
            "content": json.loads(latest["content_json"]),
        }
    return {"generatedAt": utc_now(), "sheets": sheets, "synthesis": synthesis}


def build_news_state(connection: sqlite3.Connection) -> dict:
    """AI-security watch for the Actus page."""

    items = recent_news(connection, limit=SITE_NEWS_LIMIT)
    counts: dict[str, int] = {}
    for item in items:
        counts[item["kind"]] = counts.get(item["kind"], 0) + 1
    return {"generatedAt": utc_now(), "counts": counts, "items": items}


def build_reader_index(public_state: dict, sheets_state: dict) -> dict:
    """Small key → PDF index for the bilingual reader (reader.html?k=…)."""

    with_sheet = {item["key"] for item in sheets_state["sheets"]}
    return {
        "generatedAt": public_state["generatedAt"],
        "papers": {
            paper["key"]: {
                "t": paper["title"],
                "tf": paper["titleFr"],
                "pdf": paper["readerUrl"] or paper["pdfUrl"],
                "sheet": paper["key"] in with_sheet,
            }
            for paper in public_state["papers"]
            if paper["readerUrl"] or paper["pdfUrl"]
        },
    }


def _bot_supervisor(public_state: dict) -> dict:
    papers = public_state["supervisor"]["papers"]
    readings = [paper["reading"] for paper in papers]
    return {
        "total": len(papers),
        "sheets": readings.count("sheet"),
        "queued": readings.count("queued"),
        "noPdf": readings.count("no_pdf") + readings.count("error"),
        "items": [
            {
                "key": paper["key"],
                "short": paper["short"],
                "title": paper["title"][:140],
                "year": paper["year"],
                "priority": paper["priority"],
                "family": paper["family"],
                "reading": paper["reading"],
                "url": paper["url"],
                "pdf": paper["pdf"],
            }
            for paper in papers
            if (paper["priority"] or 9) <= 2
        ],
    }


def _bot_news(news_state: dict) -> list[dict]:
    return [
        {
            "key": item["key"],
            "kind": item["kind"],
            "source": item["source"],
            "title": item["title"][:200],
            "titleFr": item["titleFr"][:200],
            "summary": item["summary"][:320],
            "fr": item["summaryFr"],
            "url": item["url"],
            "severity": item["severity"],
            "at": item["publishedAt"] or item["collectedAt"],
            "collectedAt": item["collectedAt"],
            "stars": item["extra"].get("stars"),
            "cvss": item["extra"].get("cvss"),
        }
        for item in news_state["items"][:BOT_NEWS_LIMIT]
    ]


def _bot_stage(paper: dict, human_screened: set[int]) -> str | None:
    """Which Telegram buttons a paper needs, or None when nothing is pending."""

    status = paper["status"]
    if status in {"identified", "screened"}:
        if paper["inFormalReview"]:
            return None if paper["id"] in human_screened else "ta"
        triage = paper.get("triage")
        if triage and triage["decision"] in {"include", "exclude"}:
            return None
        return "veille"
    if status == "sought" and paper["inFormalReview"] and paper.get("sheet") is not None:
        return "ft"
    if status == "assessed" and paper["inFormalReview"]:
        return "final"
    return None


def build_bot_state(
    connection: sqlite3.Connection,
    public_state: dict,
    sheets_state: dict,
    *,
    site_url: str,
    news_state: dict | None = None,
) -> dict:
    """Small snapshot for the Cloudflare worker (free tier allows ~10 ms CPU per call)."""

    human_screened = _human_title_screened(connection)
    queue = []
    for paper in public_state["papers"]:
        stage = _bot_stage(paper, human_screened)
        if stage is None:
            continue
        ai = paper.get("ai")
        triage = paper.get("triage")
        queue.append(
            {
                "key": paper["key"],
                "title": paper["title"],
                "titleFr": paper["titleFr"],
                "year": paper["year"],
                "venue": paper["venue"] or paper["source"],
                "abstract": (paper["abstract"] or "")[:BOT_ABSTRACT_CHARS],
                "abstractFr": (paper["abstractFr"] or "")[:BOT_ABSTRACT_CHARS],
                "url": paper["url"] or paper["pdfUrl"],
                "pdf": paper["readerUrl"],
                "stage": stage,
                "later": bool(triage and triage["decision"] == "later"),
                "hasSheet": paper.get("sheet") is not None,
                "ai": (
                    {
                        "decision": ai["decision"],
                        "code": ai["code"],
                        "relevance": ai["relevance"],
                        "confidence": ai["confidence"],
                        "rationale": ai["rationale"][:280],
                    }
                    if ai
                    else None
                ),
            }
        )
    stage_order = {"final": 0, "ft": 1, "ta": 2, "veille": 3}
    queue.sort(
        key=lambda item: (
            item["later"],
            stage_order[item["stage"]],
            -((item["ai"] or {}).get("relevance", -1)),
            -(item["year"] or 0),
        )
    )
    sheets = [
        {
            "key": item["key"],
            "title": item["title"],
            "year": item["year"],
            "pdf": item["pdfUrl"],
            "summary": str(item["sheet"].get("resume_simple", ""))[:500],
            "relevance": (item["sheet"].get("pertinence_pfe") or {}).get("score"),
            "eligibility": (item["sheet"].get("eligibilite") or {}).get("suggestion"),
            "checks": item["checks"].get("summary", {}),
            "createdAt": item["createdAt"],
        }
        for item in sheets_state["sheets"][:BOT_SHEETS_LIMIT]
    ]
    since = (datetime.now(UTC) - timedelta(hours=24)).replace(microsecond=0).isoformat()
    news = connection.execute(
        """
        SELECT (SELECT COUNT(*) FROM papers WHERE discovered_at >= ?) AS papers,
               (SELECT COUNT(*) FROM paper_sheets WHERE created_at >= ?) AS sheets,
               (SELECT COUNT(*) FROM ai_screening WHERE created_at >= ?) AS suggestions
        """,
        (since, since, since),
    ).fetchone()
    return {
        "schemaVersion": 1,
        "generatedAt": public_state["generatedAt"],
        "site": site_url.rstrip("/"),
        "prisma": public_state["prisma"],
        "protocol": public_state["protocol"],
        "agents": {
            key: public_state["agents"][key]
            for key in ("screenedPapers", "sheets", "readingQueue", "lastSuccessAt")
        },
        "news24h": {
            "papers": int(news["papers"] or 0),
            "sheets": int(news["sheets"] or 0),
            "suggestions": int(news["suggestions"] or 0),
        },
        "library": {"total": len(public_state["papers"]), "pending": len(queue)},
        "queue": queue[:BOT_QUEUE_LIMIT],
        "sheets": sheets,
        "supervisor": _bot_supervisor(public_state),
        "securityNews": _bot_news(news_state or build_news_state(connection)),
        "vocabulary": [
            {
                "term": word["term"],
                "fr": word["translation"],
                "def": word["definition"],
                "defFr": word["definitionFr"],
                "ex": word["example"],
                "exFr": word["exampleFr"],
                "syn": word["synonyms"][:3],
                "due": word["dueAt"],
                "reps": word["repetitions"],
            }
            for word in public_state["vocabulary"]
        ],
    }


def _write_json(path: Path, payload: dict, *, indent: int | None = 2) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    separators = None if indent else (",", ":")
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=indent, separators=separators) + "\n",
        encoding="utf-8",
    )
    return path


def export_public_state(
    connection: sqlite3.Connection,
    output_path: Path | str,
    *,
    site_url: str = "https://pfe-hla.pages.dev",
) -> Path:
    """Write state.json, plus sheets.json, news.json, reader.json and bot.json next to it."""

    path = Path(output_path)
    public_state = build_public_state(connection)
    sheets_state = build_sheets_state(connection)
    news_state = build_news_state(connection)
    _write_json(path, public_state)
    _write_json(path.with_name("sheets.json"), sheets_state)
    _write_json(path.with_name("news.json"), news_state)
    _write_json(
        path.with_name("reader.json"), build_reader_index(public_state, sheets_state), indent=None
    )
    _write_json(
        path.with_name("bot.json"),
        build_bot_state(
            connection, public_state, sheets_state, site_url=site_url, news_state=news_state
        ),
        indent=None,
    )
    return path
