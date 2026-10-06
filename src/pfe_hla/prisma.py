"""Compute PRISMA-style flow counts from the audit trail."""

from __future__ import annotations

import sqlite3
from dataclasses import asdict, dataclass


@dataclass(frozen=True, slots=True)
class PrismaCounts:
    identified: int
    unique_records: int
    duplicates_removed: int
    screened: int
    excluded_title_abstract: int
    reports_sought: int
    reports_not_retrieved: int
    reports_assessed: int
    excluded_full_text: int
    included: int
    pending_screening: int
    pending_decision: int

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


def compute_prisma_counts(connection: sqlite3.Connection) -> PrismaCounts:
    identified = int(
        connection.execute(
            """
            SELECT COALESCE(SUM(search_runs.returned_count), 0) AS n
            FROM search_runs
            JOIN search_run_details ON search_run_details.run_id=search_runs.id
            WHERE search_runs.status='ok' AND search_run_details.run_kind='review'
            """
        ).fetchone()["n"]
    )
    review_paper_ids = {
        int(row["paper_id"])
        for row in connection.execute(
            """
            SELECT DISTINCT paper_hits.paper_id
            FROM paper_hits
            JOIN search_runs ON search_runs.id=paper_hits.run_id
            JOIN search_run_details ON search_run_details.run_id=search_runs.id
            WHERE search_runs.status='ok' AND search_run_details.run_kind='review'
            """
        )
    }
    unique_records = len(review_paper_ids)
    latest_events = """
        WITH latest AS (
            SELECT paper_id, stage, MAX(id) AS event_id
            FROM screening_events GROUP BY paper_id, stage
        )
        SELECT event.paper_id, event.stage, event.decision, event.reason_code
        FROM screening_events AS event
        JOIN latest ON latest.event_id = event.id
    """
    events = list(connection.execute(latest_events))
    title_events = [
        event
        for event in events
        if event["paper_id"] in review_paper_ids and event["stage"] == "title_abstract"
    ]
    full_text_events = [
        event
        for event in events
        if event["paper_id"] in review_paper_ids and event["stage"] == "full_text"
    ]
    title_excluded = sum(event["decision"] == "exclude" for event in title_events)
    reports_not_retrieved = sum(
        event["decision"] == "exclude" and event["reason_code"] == "E7"
        for event in full_text_events
    )
    full_text_screen_excluded = sum(
        event["decision"] == "exclude" and event["reason_code"] != "E7"
        for event in full_text_events
    )
    screened = sum(event["decision"] in {"include", "exclude"} for event in title_events)
    reports_sought = sum(event["decision"] == "include" for event in title_events)
    reports_assessed = sum(
        event["decision"] in {"include", "exclude"} and event["reason_code"] != "E7"
        for event in full_text_events
    )
    latest_decisions = list(
        connection.execute(
            """
            WITH latest AS (
                SELECT paper_id, MAX(id) AS decision_id FROM decisions GROUP BY paper_id
            )
            SELECT decision.* FROM decisions AS decision
            JOIN latest ON latest.decision_id = decision.id
            """
        )
    )
    latest_decisions = [
        decision
        for decision in latest_decisions
        if decision["paper_id"] in review_paper_ids
    ]
    final_rejections = sum(row["decision"] == "reject" for row in latest_decisions)
    full_text_excluded = full_text_screen_excluded + final_rejections
    included = int(
        sum(row["decision"] == "keep" for row in latest_decisions)
    )
    pending_decision = sum(
        row["status"] == "assessed"
        for row in connection.execute("SELECT id, status FROM papers")
        if int(row["id"]) in review_paper_ids
    )
    return PrismaCounts(
        identified=identified,
        unique_records=unique_records,
        duplicates_removed=max(identified - unique_records, 0),
        screened=max(screened, 0),
        excluded_title_abstract=title_excluded,
        reports_sought=reports_sought,
        reports_not_retrieved=reports_not_retrieved,
        reports_assessed=reports_assessed,
        excluded_full_text=full_text_excluded,
        included=included,
        pending_screening=max(unique_records - screened, 0),
        pending_decision=pending_decision,
    )
