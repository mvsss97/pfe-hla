from __future__ import annotations

import json
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

from pfe_hla.collect import _looks_like_topic, collect_sources, invalidate_search_run
from pfe_hla.db import connect, init_database
from pfe_hla.english import next_schedule, record_review
from pfe_hla.export import build_public_state
from pfe_hla.library import (
    PaperRecord,
    canonical_key,
    deduplicate_by_normalized_title,
    normalize_title,
    seed_library,
    upsert_paper,
)
from pfe_hla.prisma import compute_prisma_counts
from pfe_hla.screening import (
    apply_screening_decision,
    record_final_decision,
    reopen_paper,
    suggest_title_abstract_screening,
)

ROOT = Path(__file__).resolve().parents[1]


class CompanionDatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test.db"
        init_database(self.db_path)
        self.connection = connect(self.db_path)

    def tearDown(self) -> None:
        self.connection.close()
        self.temp_dir.cleanup()

    def seed(self) -> dict[str, int]:
        result = seed_library(
            self.connection,
            ROOT / "data/seed_papers.json",
            ROOT / "data/seed_vocabulary.json",
        )
        self.connection.commit()
        return result

    def link_papers_to_formal_review(self, paper_ids: list[int] | None = None) -> None:
        """Model a documented review search that retrieves selected records."""

        if paper_ids is None:
            paper_ids = [
                int(row["id"])
                for row in self.connection.execute("SELECT id FROM papers ORDER BY id")
            ]

        cursor = self.connection.execute(
            """
            INSERT INTO search_runs(
                source, query, started_at, finished_at, returned_count,
                inserted_count, status
            ) VALUES (
                'test-index', 'documented formal query', '2026-01-01',
                '2026-01-01', ?, 0, 'ok'
            )
            """,
            (len(paper_ids),),
        )
        run_id = int(cursor.lastrowid)
        self.connection.execute(
            """
            INSERT INTO search_run_details(
                run_id, executed_query, request_url, run_kind
            ) VALUES (?, 'documented formal query', 'https://example.invalid/query', 'review')
            """,
            (run_id,),
        )
        for rank, paper_id in enumerate(paper_ids, start=1):
            self.connection.execute(
                "INSERT INTO paper_hits(run_id, paper_id, source_rank) VALUES (?, ?, ?)",
                (run_id, paper_id, rank),
            )
        self.connection.commit()

    def link_seed_to_formal_review(self) -> None:
        self.link_papers_to_formal_review()

    def test_seed_is_idempotent_and_prisma_is_derived(self) -> None:
        first = self.seed()
        second = self.seed()
        self.assertEqual(first, {"papers": 9, "vocabulary": 20})
        self.assertEqual(second, {"papers": 0, "vocabulary": 0})
        counts = compute_prisma_counts(self.connection)
        self.assertEqual(counts.identified, 0)
        self.assertEqual(counts.unique_records, 0)
        self.assertEqual(counts.screened, 0)
        self.assertEqual(counts.reports_sought, 0)
        self.assertEqual(counts.pending_screening, 0)
        self.assertEqual(counts.included, 0)

    def test_pilot_record_cannot_receive_a_formal_screening_decision(self) -> None:
        self.seed()
        with self.assertRaisesRegex(ValueError, "formal-review corpus"):
            apply_screening_decision(
                self.connection,
                paper_id=1,
                stage="title_abstract",
                decision="include",
                reason_code=None,
                rationale="This decision must wait for a formal search hit.",
            )

    def test_doi_normalization_deduplicates_sources(self) -> None:
        first = PaperRecord(
            source="one", title="An Example", doi="https://doi.org/10.1/ABC", abstract="first"
        )
        second = PaperRecord(source="two", title="Different title", doi="doi:10.1/abc")
        first_id, inserted = upsert_paper(self.connection, first)
        second_id, inserted_again = upsert_paper(self.connection, second)
        self.assertTrue(inserted)
        self.assertFalse(inserted_again)
        self.assertEqual(first_id, second_id)
        self.assertEqual(canonical_key(doi=first.doi, title=first.title), "doi:10.1/abc")

    def test_normalized_title_merges_records_with_different_identifiers(self) -> None:
        first_id, _ = upsert_paper(
            self.connection,
            PaperRecord(source="arXiv", title="A  Robust NLP—Attack!", arxiv_id="2401.12345"),
        )
        second_id, inserted = upsert_paper(
            self.connection,
            PaperRecord(
                source="OpenAlex",
                title="A robust NLP attack",
                doi="10.1000/example",
                abstract="Verified metadata abstract.",
            ),
        )
        merged = self.connection.execute(
            "SELECT * FROM papers WHERE id=?", (first_id,)
        ).fetchone()
        self.assertFalse(inserted)
        self.assertEqual(first_id, second_id)
        self.assertEqual(merged["doi"], "10.1000/example")
        self.assertEqual(merged["abstract"], "Verified metadata abstract.")
        self.assertEqual(normalize_title("Résumé robuste"), normalize_title("Resume robuste"))

    def test_same_title_with_distinct_dois_is_not_silently_merged(self) -> None:
        first_id, first_inserted = upsert_paper(
            self.connection,
            PaperRecord(source="source-a", title="Same title", doi="10.1/a"),
        )
        second_id, second_inserted = upsert_paper(
            self.connection,
            PaperRecord(source="source-b", title="Same title!", doi="10.1/b"),
        )
        self.assertTrue(first_inserted)
        self.assertTrue(second_inserted)
        self.assertNotEqual(first_id, second_id)
        self.assertEqual(deduplicate_by_normalized_title(self.connection), 0)
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) AS n FROM papers").fetchone()["n"],
            2,
        )

    def test_existing_title_duplicates_can_be_merged_with_aliases(self) -> None:
        first_id, _ = upsert_paper(
            self.connection,
            PaperRecord(source="source-a", title="Same Title", doi="10.1/a"),
        )
        # Simulate data created by the older importer, before normalized-title deduplication.
        second_id = int(
            self.connection.execute(
                """
                INSERT INTO papers(
                    canonical_key, source, external_id, doi, title, discovered_at, updated_at
                ) VALUES ('title:same title', 'source-b', '', NULL, 'Same title!', 'now', 'now')
                """
            ).lastrowid
        )
        run_id = int(
            self.connection.execute(
                """
                INSERT INTO search_runs(source, query, started_at, status)
                VALUES ('source-b', 'q', 'now', 'ok')
                """
            ).lastrowid
        )
        self.connection.execute(
            "INSERT INTO paper_hits(run_id, paper_id, source_rank) VALUES (?, ?, 1)",
            (run_id, second_id),
        )
        self.assertEqual(deduplicate_by_normalized_title(self.connection), 1)
        hit = self.connection.execute(
            "SELECT paper_id FROM paper_hits WHERE run_id=?", (run_id,)
        ).fetchone()
        aliases = {
            row["alias_value"]
            for row in self.connection.execute(
                "SELECT alias_value FROM paper_aliases WHERE paper_id=?", (first_id,)
            )
        }
        self.assertEqual(hit["paper_id"], first_id)
        self.assertIn("title:same title", aliases)

    def test_screening_requires_an_auditable_event(self) -> None:
        paper_id, _ = upsert_paper(
            self.connection,
            PaperRecord(
                source="test",
                title="Hard-label adversarial text attack",
                abstract="A decision-based attack against a BERT classifier.",
                publication_year=2024,
            ),
        )
        row = self.connection.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
        suggestion = suggest_title_abstract_screening(row)
        self.assertEqual(suggestion.decision, "include")
        self.link_papers_to_formal_review([paper_id])
        apply_screening_decision(
            self.connection,
            paper_id=paper_id,
            stage="title_abstract",
            decision="include",
            reason_code=None,
            rationale="Directly relevant.",
        )
        updated = self.connection.execute(
            "SELECT status FROM papers WHERE id=?", (paper_id,)
        ).fetchone()
        events = self.connection.execute(
            "SELECT COUNT(*) AS n FROM screening_events WHERE paper_id=?", (paper_id,)
        ).fetchone()
        self.assertEqual(updated["status"], "sought")
        self.assertEqual(events["n"], 1)

    def test_vocabulary_schedule_and_export(self) -> None:
        self.seed()
        word = self.connection.execute("SELECT * FROM vocabulary ORDER BY id LIMIT 1").fetchone()
        schedule = record_review(
            self.connection, vocabulary_id=int(word["id"]), quality=4
        )
        self.assertEqual(schedule.interval_days, 1)
        updated = self.connection.execute(
            "SELECT * FROM vocabulary WHERE id=?", (word["id"],)
        ).fetchone()
        self.assertGreater(datetime.fromisoformat(updated["due_at"]), datetime.now(UTC))
        state = build_public_state(self.connection)
        self.assertEqual(state["schemaVersion"], 1)
        self.assertEqual(len(state["papers"]), 9)
        self.assertNotIn("telegram_token", json.dumps(state))

    def test_public_export_only_exposes_verified_paper_analysis(self) -> None:
        self.seed()
        paper_ids = [
            int(row["id"])
            for row in self.connection.execute("SELECT id FROM papers ORDER BY id LIMIT 3")
        ]
        self.connection.execute(
            """
            INSERT INTO paper_analysis(
                paper_id, access_regime, attack_level, importance_method,
                search_method, perturbation_space, evidence_json,
                verification_status, notes
            ) VALUES (?, 'hard-label', 'word', 'leave-one-out', 'genetic',
                      'counter-fitted synonyms', '["table 2", "page 7"]',
                      'verified', 'Checked against the full text.')
            """,
            (paper_ids[0],),
        )
        self.connection.execute(
            """
            INSERT INTO paper_analysis(
                paper_id, access_regime, importance_method,
                verification_status, notes
            ) VALUES (?, 'hard-label', 'masking', 'partial',
                      'Hard-label claim still needs verification.')
            """,
            (paper_ids[1],),
        )
        self.connection.execute(
            "UPDATE papers SET screening_reason='Private screening rationale.' WHERE id=?",
            (paper_ids[0],),
        )

        papers = {paper["id"]: paper for paper in build_public_state(self.connection)["papers"]}
        verified = papers[paper_ids[0]]["paper_analysis"]
        partial = papers[paper_ids[1]]["paper_analysis"]

        self.assertTrue(verified["verified"])
        self.assertEqual(verified["verification_status"], "verified")
        self.assertEqual(verified["access_regime"], "hard-label")
        self.assertEqual(verified["importance_method"], "leave-one-out")
        self.assertEqual(verified["search_method"], "genetic")
        self.assertEqual(verified["perturbation_space"], "counter-fitted synonyms")
        self.assertEqual(verified["evidence"], ["table 2", "page 7"])
        self.assertNotIn("notes", verified)
        self.assertNotIn("note", papers[paper_ids[0]])

        self.assertEqual(partial, {"verification_status": "partial", "verified": False})
        self.assertIsNone(papers[paper_ids[2]]["paper_analysis"])

    def test_public_export_marks_only_valid_formal_review_hits(self) -> None:
        self.seed()
        paper_ids = [
            int(row["id"])
            for row in self.connection.execute("SELECT id FROM papers ORDER BY id LIMIT 3")
        ]

        def add_hit(paper_id: int, *, run_kind: str, status: str) -> int:
            run_id = int(
                self.connection.execute(
                    """
                    INSERT INTO search_runs(
                        source, query, started_at, finished_at,
                        returned_count, inserted_count, status
                    ) VALUES ('test', ?, '2026-01-01', '2026-01-01', 1, 1, ?)
                    """,
                    (f"{run_kind}-{status}", status),
                ).lastrowid
            )
            self.connection.execute(
                """
                INSERT INTO search_run_details(run_id, executed_query, request_url, run_kind)
                VALUES (?, ?, 'https://example.invalid/search', ?)
                """,
                (run_id, f"{run_kind}-{status}", run_kind),
            )
            self.connection.execute(
                "INSERT INTO paper_hits(run_id, paper_id, source_rank) VALUES (?, ?, 1)",
                (run_id, paper_id),
            )
            return run_id

        add_hit(paper_ids[0], run_kind="review", status="ok")
        add_hit(paper_ids[1], run_kind="pilot", status="ok")
        add_hit(paper_ids[2], run_kind="review", status="error")

        papers = {paper["id"]: paper for paper in build_public_state(self.connection)["papers"]}
        self.assertTrue(papers[paper_ids[0]]["inFormalReview"])
        self.assertFalse(papers[paper_ids[1]]["inFormalReview"])
        self.assertFalse(papers[paper_ids[2]]["inFormalReview"])

    def test_public_export_keeps_all_and_only_traceable_search_runs(self) -> None:
        traceable_ids = []
        for index in range(55):
            run_id = int(
                self.connection.execute(
                    """
                    INSERT INTO search_runs(
                        source, query, started_at, finished_at, status
                    ) VALUES ('test', ?, ?, ?, 'ok')
                    """,
                    (f"query-{index}", f"2026-01-01T00:{index:02d}:00", "2026-01-01"),
                ).lastrowid
            )
            traceable_ids.append(run_id)
            self.connection.execute(
                """
                INSERT INTO search_run_details(run_id, executed_query, request_url, run_kind)
                VALUES (?, ?, 'https://example.invalid/search', 'pilot')
                """,
                (run_id, f"query-{index}"),
            )
        orphan_id = int(
            self.connection.execute(
                """
                INSERT INTO search_runs(source, query, started_at, status)
                VALUES ('legacy', 'missing details', '2025-01-01', 'error')
                """
            ).lastrowid
        )

        search_runs = build_public_state(self.connection)["searchRuns"]
        exported_ids = {run["id"] for run in search_runs}
        self.assertEqual(len(search_runs), 55)
        self.assertEqual(exported_ids, set(traceable_ids))
        self.assertNotIn(orphan_id, exported_ids)

    def test_prisma_follows_latest_audited_transitions(self) -> None:
        self.seed()
        self.link_seed_to_formal_review()
        self.assertTrue(
            apply_screening_decision(
                self.connection,
                paper_id=1,
                stage="title_abstract",
                decision="include",
                reason_code=None,
                rationale="Relevant abstract.",
            )
        )
        self.assertFalse(
            apply_screening_decision(
                self.connection,
                paper_id=1,
                stage="title_abstract",
                decision="include",
                reason_code=None,
                rationale="Replay must be idempotent.",
            )
        )
        apply_screening_decision(
            self.connection,
            paper_id=1,
            stage="full_text",
            decision="include",
            reason_code=None,
            rationale="Eligible full text.",
        )
        record_final_decision(
            self.connection, paper_id=1, decision="keep", note="Final inclusion."
        )
        apply_screening_decision(
            self.connection,
            paper_id=2,
            stage="title_abstract",
            decision="include",
            reason_code=None,
            rationale="Relevant abstract.",
        )
        apply_screening_decision(
            self.connection,
            paper_id=2,
            stage="full_text",
            decision="exclude",
            reason_code="E6",
            rationale="Out of scope after full-text review.",
        )
        counts = compute_prisma_counts(self.connection)
        self.assertEqual(counts.screened, 2)
        self.assertEqual(counts.reports_sought, 2)
        self.assertEqual(counts.reports_assessed, 2)
        self.assertEqual(counts.excluded_full_text, 1)
        self.assertEqual(counts.included, 1)
        self.assertEqual(counts.pending_screening, 7)

    def test_final_rejection_and_not_retrieved_have_distinct_prisma_counts(self) -> None:
        self.seed()
        self.link_seed_to_formal_review()
        for paper_id in (1, 2):
            apply_screening_decision(
                self.connection,
                paper_id=paper_id,
                stage="title_abstract",
                decision="include",
                reason_code=None,
                rationale="Relevant metadata.",
            )
        apply_screening_decision(
            self.connection,
            paper_id=1,
            stage="full_text",
            decision="include",
            reason_code=None,
            rationale="Assessed in full.",
        )
        record_final_decision(
            self.connection,
            paper_id=1,
            decision="reject",
            reason_code="E6",
            note="Out of scope after assessment.",
        )
        apply_screening_decision(
            self.connection,
            paper_id=2,
            stage="full_text",
            decision="exclude",
            reason_code="E7",
            rationale="Full text unavailable.",
        )
        counts = compute_prisma_counts(self.connection)
        self.assertEqual(counts.reports_sought, 2)
        self.assertEqual(counts.reports_not_retrieved, 1)
        self.assertEqual(counts.reports_assessed, 1)
        self.assertEqual(counts.excluded_full_text, 1)

    def test_reopen_supersedes_decision_but_preserves_history(self) -> None:
        self.seed()
        self.link_seed_to_formal_review()
        apply_screening_decision(
            self.connection,
            paper_id=1,
            stage="title_abstract",
            decision="include",
            reason_code=None,
            rationale="Relevant metadata.",
        )
        apply_screening_decision(
            self.connection,
            paper_id=1,
            stage="full_text",
            decision="include",
            reason_code=None,
            rationale="Eligible.",
        )
        record_final_decision(self.connection, paper_id=1, decision="keep")
        reopen_paper(
            self.connection,
            paper_id=1,
            target_status="identified",
            rationale="Metadata conflict discovered.",
        )
        counts = compute_prisma_counts(self.connection)
        paper = self.connection.execute("SELECT status FROM papers WHERE id=1").fetchone()
        history = self.connection.execute(
            "SELECT COUNT(*) AS n FROM decisions WHERE paper_id=1"
        ).fetchone()["n"]
        self.assertEqual(paper["status"], "identified")
        self.assertEqual(counts.included, 0)
        self.assertEqual(counts.pending_screening, 9)
        self.assertEqual(history, 2)

    def test_invalid_screening_transition_is_rejected(self) -> None:
        self.seed()
        self.link_seed_to_formal_review()
        with self.assertRaises(ValueError):
            apply_screening_decision(
                self.connection,
                paper_id=1,
                stage="full_text",
                decision="include",
                reason_code=None,
                rationale="Cannot skip title and abstract screening.",
            )

    def test_uncertain_full_text_can_be_resolved_later(self) -> None:
        self.seed()
        self.link_seed_to_formal_review()
        apply_screening_decision(
            self.connection,
            paper_id=1,
            stage="title_abstract",
            decision="include",
            reason_code=None,
            rationale="Relevant metadata.",
        )
        apply_screening_decision(
            self.connection,
            paper_id=1,
            stage="full_text",
            decision="uncertain",
            reason_code=None,
            rationale="Need to verify the oracle output.",
        )
        status = self.connection.execute(
            "SELECT status FROM papers WHERE id=1"
        ).fetchone()["status"]
        self.assertEqual(status, "sought")
        self.assertTrue(
            apply_screening_decision(
                self.connection,
                paper_id=1,
                stage="full_text",
                decision="include",
                reason_code=None,
                rationale="Hard-label access confirmed.",
            )
        )

    def test_exclusion_codes_are_validated_by_stage_and_decision(self) -> None:
        self.seed()
        self.link_seed_to_formal_review()
        apply_screening_decision(
            self.connection,
            paper_id=1,
            stage="title_abstract",
            decision="include",
            reason_code=None,
            rationale="Relevant metadata.",
        )
        with self.assertRaises(ValueError):
            apply_screening_decision(
                self.connection,
                paper_id=1,
                stage="full_text",
                decision="include",
                reason_code="E7",
                rationale="Contradictory code.",
            )
        row = self.connection.execute(
            "SELECT status FROM papers WHERE id=1"
        ).fetchone()
        self.assertEqual(row["status"], "sought")
        self.assertEqual(
            self.connection.execute(
                "SELECT COUNT(*) AS n FROM screening_events WHERE paper_id=1"
            ).fetchone()["n"],
            1,
        )

    def test_invalid_search_run_is_removed_from_prisma_without_erasing_audit(self) -> None:
        self.seed()
        self.link_seed_to_formal_review()
        paper_id, _ = upsert_paper(
            self.connection,
            PaperRecord(source="broken", title="Clearly unrelated temporary record"),
        )
        cursor = self.connection.execute(
            """
            INSERT INTO search_runs(
                source, query, started_at, finished_at, returned_count, inserted_count, status
            ) VALUES ('arXiv', 'broken syntax', '2026-01-01', '2026-01-01', 1, 1, 'ok')
            """
        )
        run_id = int(cursor.lastrowid)
        self.connection.execute(
            """
            INSERT INTO search_run_details(run_id, executed_query, request_url, run_kind)
            VALUES (?, 'broken syntax', 'https://example.invalid', 'review')
            """,
            (run_id,),
        )
        self.connection.execute(
            "INSERT INTO paper_hits(run_id, paper_id, source_rank) VALUES (?, ?, 1)",
            (run_id, paper_id),
        )
        self.assertEqual(compute_prisma_counts(self.connection).identified, 10)
        removed = invalidate_search_run(
            self.connection, run_id=run_id, reason="query parser defect"
        )
        self.assertEqual(removed, 1)
        self.assertEqual(compute_prisma_counts(self.connection).identified, 9)
        audit = self.connection.execute(
            "SELECT * FROM search_runs WHERE id=?", (run_id,)
        ).fetchone()
        self.assertEqual(audit["status"], "error")
        self.assertIn("INVALIDATED", audit["error"])

    def test_formal_search_identity_includes_limit_and_exact_url(self) -> None:
        with patch("pfe_hla.collect.search_openalex", return_value=[]):
            first = list(
                collect_sources(
                    self.connection,
                    queries=("hard label NLP",),
                    sources=("openalex",),
                    limit=20,
                    run_kind="review",
                )
            )[0]
            second = list(
                collect_sources(
                    self.connection,
                    queries=("hard label NLP",),
                    sources=("openalex",),
                    limit=100,
                    run_kind="review",
                )
            )[0]
            replay = list(
                collect_sources(
                    self.connection,
                    queries=("hard label NLP",),
                    sources=("openalex",),
                    limit=100,
                    run_kind="review",
                )
            )[0]
        self.assertFalse(first.skipped)
        self.assertFalse(second.skipped)
        self.assertTrue(replay.skipped)
        urls = [
            row["request_url"]
            for row in self.connection.execute(
                "SELECT request_url FROM search_run_details ORDER BY run_id"
            )
        ]
        self.assertEqual(len(urls), 2)
        self.assertIn("per-page=20", urls[0])
        self.assertIn("per-page=100", urls[1])
        self.assertIn("search=hard+label+NLP", urls[0])

    def test_arxiv_collection_respects_three_second_cadence(self) -> None:
        with (
            patch("pfe_hla.collect.search_arxiv", return_value=[]),
            patch("pfe_hla.collect.time.monotonic", side_effect=(10.0, 11.0, 14.0)),
            patch("pfe_hla.collect.time.sleep") as sleep,
        ):
            results = list(
                collect_sources(
                    self.connection,
                    queries=("first", "second"),
                    sources=("arxiv",),
                    run_kind="pilot",
                )
            )
        self.assertEqual(len(results), 2)
        sleep.assert_called_once_with(2.0)


class ScheduleTests(unittest.TestCase):
    def test_failure_resets_repetitions(self) -> None:
        result = next_schedule(ease=2.5, repetitions=4, interval_days=12, quality=2)
        self.assertEqual(result.repetitions, 0)
        self.assertEqual(result.interval_days, 1)

    def test_success_grows_intervals(self) -> None:
        first = next_schedule(ease=2.5, repetitions=0, interval_days=0, quality=5)
        second = next_schedule(
            ease=first.ease,
            repetitions=first.repetitions,
            interval_days=first.interval_days,
            quality=5,
        )
        third = next_schedule(
            ease=second.ease,
            repetitions=second.repetitions,
            interval_days=second.interval_days,
            quality=5,
        )
        self.assertEqual((first.interval_days, second.interval_days), (1, 3))
        self.assertGreater(third.interval_days, second.interval_days)


class CollectionSmokeTests(unittest.TestCase):
    def test_topic_smoke_check_rejects_unrelated_query_results(self) -> None:
        self.assertFalse(
            _looks_like_topic(
                PaperRecord(source="arXiv", title="Hydrodynamic traffic flow", abstract="")
            )
        )
        self.assertTrue(
            _looks_like_topic(
                PaperRecord(
                    source="arXiv",
                    title="Hard-label adversarial attack on text classifiers",
                    abstract="",
                )
            )
        )


if __name__ == "__main__":
    unittest.main()
