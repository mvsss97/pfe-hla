from __future__ import annotations

import sys
import unittest
from collections.abc import Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from pfe_hla.research.attack import (  # noqa: E402
    AttackConstraints,
    GreedyHardLabelAttack,
)
from pfe_hla.research.oracle import BudgetedOracle  # noqa: E402
from pfe_hla.research.wir import WIRMethod  # noqa: E402


def combination_model(text: str) -> str:
    words = set(text.split())
    return "adversarial" if {"omega", "theta"} <= words else "original"


def combination_candidates(
    token: str, index: int, tokens: Sequence[str]
) -> tuple[str, ...]:
    del index, tokens
    return {"alpha": ("omega",), "beta": ("theta",)}.get(token, ())


class AttackTests(unittest.TestCase):
    def test_greedy_path_stops_at_first_success(self) -> None:
        oracle = BudgetedOracle(combination_model, 20)
        attack = GreedyHardLabelAttack(
            oracle,
            combination_candidates,
            wir_method=WIRMethod.DELETION,
        )

        result = attack.run("alpha beta")

        self.assertTrue(result.success)
        self.assertEqual(result.adversarial_text, "omega theta")
        self.assertEqual(result.final_label, "adversarial")
        self.assertEqual(result.metrics.changed_tokens, 2)
        self.assertEqual(result.metrics.change_rate, 1.0)
        self.assertEqual([edit.index for edit in result.edits], [0, 1])
        self.assertEqual(result.reason, "success")

    def test_change_constraint_prevents_second_edit(self) -> None:
        oracle = BudgetedOracle(combination_model, 20)
        attack = GreedyHardLabelAttack(
            oracle,
            combination_candidates,
            constraints=AttackConstraints(max_changed_tokens=1),
        )

        result = attack.run("alpha beta")

        self.assertFalse(result.success)
        self.assertEqual(result.adversarial_text, "omega beta")
        self.assertEqual(result.reason, "constraints_exhausted")
        self.assertEqual(result.metrics.changed_tokens, 1)

    def test_budget_exhaustion_is_a_reported_outcome(self) -> None:
        # Baseline + two deletion-WIR queries consume the complete budget.
        oracle = BudgetedOracle(combination_model, 3)
        attack = GreedyHardLabelAttack(oracle, combination_candidates)

        result = attack.run("alpha beta")

        self.assertFalse(result.success)
        self.assertEqual(result.reason, "query_budget_exhausted")
        self.assertEqual(result.metrics.queries, 3)
        self.assertEqual(result.metrics.ranking_queries, 2)
        self.assertEqual(result.metrics.attack_queries, 0)

    def test_target_already_satisfied_needs_only_baseline_query(self) -> None:
        oracle = BudgetedOracle(combination_model, 1)
        attack = GreedyHardLabelAttack(oracle, combination_candidates)

        result = attack.run("alpha beta", target_label="original")

        self.assertTrue(result.success)
        self.assertTrue(result.targeted)
        self.assertEqual(result.reason, "already_satisfied")
        self.assertEqual(result.metrics.queries, 1)

    def test_multi_token_and_non_alphabetic_candidates_are_filtered(self) -> None:
        def invalid_candidates(
            token: str, index: int, tokens: Sequence[str]
        ) -> tuple[str, ...]:
            del token, index, tokens
            return ("two words", "!!!")

        oracle = BudgetedOracle(lambda text: "same", 10)
        result = GreedyHardLabelAttack(oracle, invalid_candidates).run("alpha")

        self.assertFalse(result.success)
        self.assertEqual(result.reason, "search_exhausted")
        self.assertEqual(result.metrics.candidates_evaluated, 0)
        self.assertEqual(result.adversarial_text, "alpha")


if __name__ == "__main__":
    unittest.main()
