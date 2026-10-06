from __future__ import annotations

import sys
import unittest
from collections.abc import Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from pfe_hla.research.oracle import BudgetedOracle  # noqa: E402
from pfe_hla.research.tokenization import WhitespaceTokenizer  # noqa: E402
from pfe_hla.research.wir import (  # noqa: E402
    WIRMethod,
    deletion_wir,
    masking_wir,
    neighborhood_voting_wir,
    rank_tokens,
)


def bad_word_model(text: str) -> str:
    return "negative" if "bad" in text.split() else "positive"


class WIRTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tokenizer = WhitespaceTokenizer()

    def test_deletion_uses_binary_label_change_and_stable_ties(self) -> None:
        oracle = BudgetedOracle(bad_word_model, 10)
        tokens = ["plain", "text", "bad"]
        original = oracle.query("plain text bad")

        ranking = deletion_wir(tokens, original, oracle, tokenizer=self.tokenizer)

        self.assertEqual([item.index for item in ranking], [2, 0, 1])
        self.assertEqual([item.score for item in ranking], [1.0, 0.0, 0.0])
        self.assertEqual(oracle.queries_used, 4)

    def test_masking_changes_only_the_selected_position(self) -> None:
        oracle = BudgetedOracle(
            lambda text: "masked" if "[MASK]" in text.split() else "clean", 10
        )
        tokens = ["alpha", "beta"]

        ranking = masking_wir(tokens, "clean", oracle, tokenizer=self.tokenizer)

        self.assertEqual([item.index for item in ranking], [0, 1])
        self.assertTrue(all(item.score == 1.0 for item in ranking))

    def test_neighborhood_score_is_fraction_of_changed_votes(self) -> None:
        oracle = BudgetedOracle(bad_word_model, 10)

        def neighbors(
            token: str, index: int, tokens: Sequence[str]
        ) -> tuple[str, ...]:
            del index, tokens
            return {
                "good": ("bad", "excellent", "excellent", "good"),
                "movie": ("film",),
            }.get(token, ())

        ranking = neighborhood_voting_wir(
            ["good", "movie"],
            "positive",
            oracle,
            neighbors,
            tokenizer=self.tokenizer,
        )

        self.assertEqual([item.index for item in ranking], [0, 1])
        self.assertEqual(ranking[0].observations, 2)
        self.assertEqual(ranking[0].changed_votes, 1)
        self.assertEqual(ranking[0].score, 0.5)
        self.assertEqual(ranking[1].score, 0.0)
        self.assertEqual(oracle.queries_used, 3)

    def test_dispatch_requires_neighbors_for_neighborhood_method(self) -> None:
        oracle = BudgetedOracle(bad_word_model, 5)
        with self.assertRaises(ValueError):
            rank_tokens(
                ["good"],
                "positive",
                oracle,
                method=WIRMethod.NEIGHBORHOOD,
            )


if __name__ == "__main__":
    unittest.main()
