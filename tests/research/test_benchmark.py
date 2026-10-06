from __future__ import annotations

import json
import sys
import tempfile
import unittest
from collections.abc import Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from pfe_hla.research.benchmark import (  # noqa: E402
    BenchmarkConfig,
    BenchmarkExample,
    BenchmarkRunner,
    read_examples_jsonl,
    run_jsonl_benchmark,
)
from pfe_hla.research.wir import WIRMethod  # noqa: E402


class WordModel:
    def __init__(self) -> None:
        self.calls = 0

    def predict(self, text: str) -> str:
        self.calls += 1
        words = text.split()
        if "bad" in words:
            return "negative"
        if "good" in words:
            return "positive"
        return "neutral"


class RecordingFactory:
    def __init__(self) -> None:
        self.seeds: list[int] = []

    def __call__(self, seed: int):
        self.seeds.append(seed)

        def provider(
            token: str, index: int, tokens: Sequence[str]
        ) -> tuple[str, ...]:
            del index, tokens
            return ("bad",) if token == "good" else ()

        return provider


class BenchmarkTests(unittest.TestCase):
    def test_filters_wrong_examples_and_uses_honest_asr_denominator(self) -> None:
        model = WordModel()
        factory = RecordingFactory()
        runner = BenchmarkRunner(
            model,
            substitution_factory=factory,
            config=BenchmarkConfig(query_budget=10, seed=42),
            valid_labels=("positive", "negative", "neutral"),
        )

        report = runner.run(
            (
                BenchmarkExample("eligible", "good", "positive"),
                BenchmarkExample("wrong", "bad", "positive"),
            )
        )

        self.assertEqual(report.total_examples, 2)
        self.assertEqual(report.eligible_examples, 1)
        self.assertEqual(report.filtered_initially_misclassified, 1)
        self.assertEqual(report.screening_queries, 2)
        self.assertFalse(report.examples[1].eligible)
        self.assertEqual(report.examples[1].skip_reason, "initial_misclassification")
        self.assertEqual(report.examples[1].methods, ())
        self.assertEqual(len(factory.seeds), 3)
        self.assertEqual(len(set(factory.seeds)), 1)

        for aggregate in report.aggregates:
            self.assertEqual(aggregate.asr_numerator, 1)
            self.assertEqual(aggregate.asr_denominator, 1)
            self.assertEqual(aggregate.asr, 1.0)
            self.assertEqual(aggregate.attacks_attempted, 1)
            self.assertEqual(aggregate.total_attack_queries, 3)
            self.assertEqual(aggregate.mean_changed_tokens, 1.0)

    def test_zero_eligible_examples_produces_null_asr(self) -> None:
        runner = BenchmarkRunner(
            WordModel(),
            substitutions=lambda token, index, tokens: (),
            config=BenchmarkConfig(methods=(WIRMethod.DELETION,), query_budget=5),
        )

        report = runner.run((BenchmarkExample("wrong", "bad", "positive"),))
        aggregate = report.aggregates[0]

        self.assertEqual(aggregate.asr_denominator, 0)
        self.assertIsNone(aggregate.asr)
        self.assertIsNone(aggregate.mean_queries)
        self.assertEqual(aggregate.attacks_attempted, 0)

    def test_small_budget_is_recorded_as_failure_not_dropped(self) -> None:
        runner = BenchmarkRunner(
            WordModel(),
            substitutions=lambda token, index, tokens: ("bad",),
            config=BenchmarkConfig(methods=("deletion",), query_budget=1),
        )

        report = runner.run((BenchmarkExample("one", "good", "positive"),))
        aggregate = report.aggregates[0]

        self.assertEqual(aggregate.asr, 0.0)
        self.assertEqual(aggregate.asr_denominator, 1)
        self.assertEqual(aggregate.query_budget_exhaustions, 1)
        self.assertEqual(aggregate.total_attack_queries, 1)

    def test_jsonl_entry_point_writes_examples_and_aggregates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.jsonl"
            output_path = root / "results.jsonl"
            input_path.write_text(
                '{"id":"a","text":"good","label":"positive"}\n'
                '{"id":"b","text":"bad","label":"positive"}\n',
                encoding="utf-8",
            )

            examples = read_examples_jsonl(input_path)
            self.assertEqual([example.example_id for example in examples], ["a", "b"])
            report = run_jsonl_benchmark(
                input_path,
                output_path,
                WordModel(),
                substitutions=lambda token, index, tokens: (
                    ("bad",) if token == "good" else ()
                ),
                config=BenchmarkConfig(query_budget=10),
                provenance={"model": {"revision": "test-revision"}},
            )
            records = [
                json.loads(line)
                for line in output_path.read_text(encoding="utf-8").splitlines()
            ]

        self.assertEqual(len(records), 6)
        self.assertEqual(records[0]["record_type"], "metadata")
        self.assertEqual(records[0]["eligible_examples"], 1)
        self.assertEqual(records[0]["query_budget_per_method"], 10)
        self.assertEqual(records[0]["attack_constraints"]["max_change_ratio"], 1.0)
        self.assertIn("blake2s-32", records[0]["seed_derivation"])
        self.assertEqual(
            records[0]["provenance"]["model"]["revision"], "test-revision"
        )
        self.assertEqual(
            [record["record_type"] for record in records[-3:]],
            ["aggregate", "aggregate", "aggregate"],
        )
        self.assertEqual(report.aggregates[0].asr, 1.0)

    def test_duplicate_example_ids_are_rejected(self) -> None:
        runner = BenchmarkRunner(
            WordModel(),
            substitutions=lambda token, index, tokens: (),
        )
        with self.assertRaisesRegex(ValueError, "identifiers must be unique"):
            runner.run(
                (
                    BenchmarkExample("same", "good", "positive"),
                    BenchmarkExample("same", "good", "positive"),
                )
            )


if __name__ == "__main__":
    unittest.main()
