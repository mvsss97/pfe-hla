"""Bring Telegram decisions from the Cloudflare worker into the research database.

The worker only queues events in KV. This module applies them through the same
audited functions as the CLI (formal screening, final decisions, vocabulary
reviews). Papers outside the formal review corpus receive a *triage* record that
is carried into formal screening once a documented review run retrieves them.

Events are acknowledged only after the database has been saved, so a failed CI
run replays them instead of losing them.
"""

from __future__ import annotations

import json
import sqlite3
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from pfe_hla.collect import _verified_ssl_context
from pfe_hla.english import record_review
from pfe_hla.library import in_formal_review, paper_key_index, utc_now
from pfe_hla.screening import (
    FINAL_EXCLUSION_CODES,
    FULL_TEXT_EXCLUSION_CODES,
    TITLE_ABSTRACT_EXCLUSION_CODES,
    apply_screening_decision,
    record_final_decision,
)

EXCLUSION_LABELS = {
    "E1": "Modalité non textuelle",
    "E2": "Hors attaque/robustesse NLP",
    "E3": "Hors fenêtre temporelle",
    "E4": "Langue non admise",
    "E5": "Pas une étude scientifique",
    "E6": "Hors sujet après lecture intégrale",
    "E7": "Texte intégral indisponible",
    "E8": "Doublon d'une version plus complète",
}
HUMAN_REVIEWER = "human-telegram"


@dataclass(slots=True)
class SyncReport:
    applied: list[str] = field(default_factory=list)
    triaged: list[str] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)

    @property
    def processed_ids(self) -> list[str]:
        # Skipped events are acknowledged too: replaying an invalid event forever
        # would block the queue. Their reason is printed in the CI log.
        return self.applied + self.triaged + [event_id for event_id, _ in self.skipped]


def _request(url: str, secret: str, *, payload: dict | None = None) -> Any:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method="POST" if payload is not None else "GET",
        headers={
            "Authorization": f"Bearer {secret}",
            "Content-Type": "application/json",
            "User-Agent": "PFE-HLA/0.2 pipeline",
        },
    )
    with urllib.request.urlopen(  # noqa: S310
        request, timeout=30, context=_verified_ssl_context()
    ) as response:
        return json.loads(response.read().decode("utf-8") or "null")


def fetch_events(worker_url: str, secret: str) -> list[dict[str, Any]]:
    payload = _request(worker_url.rstrip("/") + "/api/events", secret)
    events = (payload or {}).get("events", [])
    return [event for event in events if isinstance(event, dict) and event.get("id")]


def acknowledge_events(worker_url: str, secret: str, event_ids: list[str]) -> int:
    if not event_ids:
        return 0
    payload = _request(
        worker_url.rstrip("/") + "/api/events/ack", secret, payload={"ids": event_ids}
    )
    return int((payload or {}).get("deleted", 0))


def queue_for_reading(
    connection: sqlite3.Connection, paper_id: int, *, priority: int, reason: str
) -> None:
    connection.execute(
        """
        INSERT INTO reading_queue(paper_id, priority, reason, queued_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(paper_id) DO UPDATE SET
            priority=MAX(reading_queue.priority, excluded.priority),
            reason=CASE WHEN excluded.priority > reading_queue.priority
                        THEN excluded.reason ELSE reading_queue.reason END
        """,
        (paper_id, priority, reason, utc_now()),
    )


def _record_triage(
    connection: sqlite3.Connection,
    *,
    paper_id: int,
    decision: str,
    code: str | None,
    event_ref: str,
    decided_at: str,
) -> None:
    connection.execute(
        """
        INSERT INTO triage_events(paper_id, decision, reason_code, channel, event_ref, decided_at)
        VALUES (?, ?, ?, 'telegram', ?, ?)
        """,
        (paper_id, decision, code, event_ref, decided_at),
    )


def _screen_rationale(decision: str, code: str | None, stage: str) -> str:
    if decision == "exclude" and code:
        return f"{code} · {EXCLUSION_LABELS.get(code, 'exclusion')} (décision Telegram)"
    if decision == "uncertain":
        return "Cas incertain signalé sur Telegram ; à revoir avec l'encadrant."
    if stage == "full_text":
        return "Texte intégral jugé éligible (décision Telegram)."
    return "Titre/résumé pertinent ; texte intégral à récupérer (décision Telegram)."


def _apply_screen_event(
    connection: sqlite3.Connection, event: dict[str, Any], paper_id: int, report: SyncReport
) -> None:
    event_id = str(event["id"])
    decision = str(event.get("decision", ""))
    code = event.get("code") or None
    decided_at = str(event.get("at") or utc_now())
    if decision not in {"include", "exclude", "uncertain", "later"}:
        report.skipped.append((event_id, f"unknown decision {decision!r}"))
        return
    if decision == "later":
        _record_triage(
            connection, paper_id=paper_id, decision="later", code=None,
            event_ref=event_id, decided_at=decided_at,
        )
        report.triaged.append(event_id)
        return
    status = connection.execute(
        "SELECT status FROM papers WHERE id=?", (paper_id,)
    ).fetchone()["status"]
    stage = "full_text" if status == "sought" else "title_abstract"
    allowed = FULL_TEXT_EXCLUSION_CODES if stage == "full_text" else TITLE_ABSTRACT_EXCLUSION_CODES
    if decision == "exclude" and code not in allowed:
        report.skipped.append((event_id, f"code {code!r} not allowed at {stage}"))
        return
    if decision != "exclude":
        code = None
    formal = in_formal_review(connection, paper_id)
    if formal and status not in {"identified", "screened", "sought"}:
        report.skipped.append(
            (event_id, f"paper already {status}; amend it with `pfe_hla reopen`")
        )
        return
    if formal:
        apply_screening_decision(
            connection,
            paper_id=paper_id,
            stage=stage,
            decision=decision,
            reason_code=code,
            rationale=_screen_rationale(decision, code, stage),
            reviewer=HUMAN_REVIEWER,
        )
        report.applied.append(event_id)
    else:
        _record_triage(
            connection, paper_id=paper_id, decision=decision, code=code,
            event_ref=event_id, decided_at=decided_at,
        )
        report.triaged.append(event_id)
    if decision == "include":
        queue_for_reading(connection, paper_id, priority=80, reason="Gardé sur Telegram")


def apply_events(connection: sqlite3.Connection, events: list[dict[str, Any]]) -> SyncReport:
    """Apply worker events; each event is isolated so one bad tap never blocks others."""

    report = SyncReport()
    keys = paper_key_index(connection)
    for event in sorted(events, key=lambda item: str(item.get("at", ""))):
        event_id = str(event["id"])
        kind = str(event.get("type", ""))
        savepoint = "sync_event"
        connection.execute(f"SAVEPOINT {savepoint}")
        try:
            if kind == "vocab":
                term = str(event.get("term", "")).strip()
                row = connection.execute(
                    "SELECT id FROM vocabulary WHERE term=? COLLATE NOCASE", (term,)
                ).fetchone()
                if row is None:
                    report.skipped.append((event_id, f"unknown term {term!r}"))
                else:
                    record_review(
                        connection,
                        vocabulary_id=int(row["id"]),
                        quality=int(event.get("quality", 0)),
                    )
                    report.applied.append(event_id)
            elif kind in {"screen", "final", "read"}:
                paper_id = keys.get(str(event.get("key", "")))
                if paper_id is None:
                    report.skipped.append((event_id, f"unknown paper key {event.get('key')!r}"))
                elif kind == "screen":
                    _apply_screen_event(connection, event, paper_id, report)
                elif kind == "read":
                    queue_for_reading(
                        connection, paper_id, priority=90, reason="Lecture demandée sur Telegram"
                    )
                    report.applied.append(event_id)
                else:
                    decision = str(event.get("decision", ""))
                    code = event.get("code") or None
                    if decision == "reject" and code not in FINAL_EXCLUSION_CODES:
                        report.skipped.append((event_id, f"final code {code!r} not allowed"))
                    else:
                        record_final_decision(
                            connection,
                            paper_id=paper_id,
                            decision=decision,
                            reason_code=code if decision == "reject" else None,
                            note=(
                                f"{code} · {EXCLUSION_LABELS.get(code, '')} (Telegram)"
                                if decision == "reject"
                                else "Inclusion finale décidée sur Telegram."
                            ),
                            channel="telegram",
                        )
                        report.applied.append(event_id)
            else:
                report.skipped.append((event_id, f"unknown event type {kind!r}"))
            connection.execute(f"RELEASE {savepoint}")
        except (KeyError, ValueError, TypeError, sqlite3.DatabaseError) as exc:
            connection.execute(f"ROLLBACK TO {savepoint}")
            connection.execute(f"RELEASE {savepoint}")
            report.skipped.append((event_id, f"{type(exc).__name__}: {exc}"))
    return report


def carry_triage_into_review(connection: sqlite3.Connection) -> int:
    """Turn early human triage into formal screening once the paper is in the corpus.

    The human made the call on the same title/abstract during the veille; the
    rationale keeps the original date so the PRISMA log stays honest.
    """

    carried = 0
    rows = list(
        connection.execute(
            """
            WITH latest AS (
                SELECT paper_id, MAX(id) AS id FROM triage_events
                WHERE decision IN ('include', 'exclude', 'uncertain') GROUP BY paper_id
            )
            SELECT triage.* FROM triage_events AS triage
            JOIN latest ON latest.id = triage.id
            JOIN papers ON papers.id = triage.paper_id
            WHERE triage.carried_event_id IS NULL
              AND papers.status IN ('identified', 'screened')
              AND NOT EXISTS (
                  SELECT 1 FROM screening_events
                  WHERE screening_events.paper_id = triage.paper_id
                    AND screening_events.stage = 'title_abstract'
              )
            """
        )
    )
    for row in rows:
        paper_id = int(row["paper_id"])
        if not in_formal_review(connection, paper_id):
            continue
        code = row["reason_code"] if row["decision"] == "exclude" else None
        if row["decision"] == "exclude" and code not in TITLE_ABSTRACT_EXCLUSION_CODES:
            continue
        rationale = (
            f"{_screen_rationale(str(row['decision']), code, 'title_abstract')} "
            f"Décision humaine du {str(row['decided_at'])[:10]} (veille), "
            "reportée au corpus formel."
        )
        apply_screening_decision(
            connection,
            paper_id=paper_id,
            stage="title_abstract",
            decision=str(row["decision"]),
            reason_code=code,
            rationale=rationale,
            reviewer=HUMAN_REVIEWER,
        )
        event = connection.execute(
            "SELECT MAX(id) AS id FROM screening_events WHERE paper_id=?", (paper_id,)
        ).fetchone()
        connection.execute(
            "UPDATE triage_events SET carried_event_id=? WHERE id=?", (event["id"], row["id"])
        )
        carried += 1
    return carried


def notify_worker(worker_url: str, secret: str, summary: dict[str, Any]) -> bool:
    try:
        _request(worker_url.rstrip("/") + "/api/pipeline", secret, payload=summary)
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        return False
    return True
