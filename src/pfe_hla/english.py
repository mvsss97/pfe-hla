"""Small SM-2-inspired spaced-repetition scheduler for domain vocabulary."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from pfe_hla.library import utc_now


@dataclass(frozen=True, slots=True)
class Schedule:
    ease: float
    repetitions: int
    interval_days: int


def next_schedule(*, ease: float, repetitions: int, interval_days: int, quality: int) -> Schedule:
    """Return the next review schedule for a quality score from 0 to 5.

    Quality 0–2 means forgotten; 3 means difficult; 4 means correct; 5 means easy.
    """

    if not 0 <= quality <= 5:
        raise ValueError("quality must be between 0 and 5")
    updated_ease = max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)))
    if quality < 3:
        return Schedule(updated_ease, 0, 1)
    next_repetitions = repetitions + 1
    if next_repetitions == 1:
        next_interval = 1
    elif next_repetitions == 2:
        next_interval = 3
    else:
        next_interval = max(1, round(max(interval_days, 1) * updated_ease))
    return Schedule(updated_ease, next_repetitions, next_interval)


def due_words(connection: sqlite3.Connection, *, limit: int = 5) -> list[sqlite3.Row]:
    return list(
        connection.execute(
            """
            SELECT * FROM vocabulary
            WHERE due_at <= ?
            ORDER BY due_at, repetitions, term
            LIMIT ?
            """,
            (utc_now(), limit),
        )
    )


def record_review(
    connection: sqlite3.Connection,
    *,
    vocabulary_id: int,
    quality: int,
) -> Schedule:
    row = connection.execute(
        "SELECT * FROM vocabulary WHERE id=?", (vocabulary_id,)
    ).fetchone()
    if row is None:
        raise KeyError(f"Unknown vocabulary id {vocabulary_id}")
    schedule = next_schedule(
        ease=float(row["ease"]),
        repetitions=int(row["repetitions"]),
        interval_days=int(row["interval_days"]),
        quality=quality,
    )
    now = datetime.now(UTC).replace(microsecond=0)
    due = now + timedelta(days=schedule.interval_days)
    connection.execute(
        """
        INSERT INTO vocabulary_reviews(
            vocabulary_id, quality, reviewed_at, previous_interval, next_interval
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            vocabulary_id,
            quality,
            now.isoformat(),
            int(row["interval_days"]),
            schedule.interval_days,
        ),
    )
    connection.execute(
        """
        UPDATE vocabulary
        SET ease=?, repetitions=?, interval_days=?, due_at=?, last_reviewed_at=?
        WHERE id=?
        """,
        (
            schedule.ease,
            schedule.repetitions,
            schedule.interval_days,
            due.isoformat(),
            now.isoformat(),
            vocabulary_id,
        ),
    )
    return schedule


def format_word_card(row: sqlite3.Row, *, reveal: bool = True) -> str:
    if not reveal:
        return f"🇬🇧 <b>{row['term']}</b>\nEssaie de donner le sens avant d'afficher la réponse."
    synonyms = ", ".join(json.loads(row["synonyms_json"])) or "—"
    return (
        f"🇬🇧 <b>{row['term']}</b> — {row['translation_fr']}\n"
        f"{row['definition_en']}\n"
        f"Synonyms: {synonyms}\n"
        f"<i>{row['example_en']}</i>"
    )
