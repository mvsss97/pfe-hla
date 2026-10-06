from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from pfe_hla.research.oracle import (  # noqa: E402
    BudgetedOracle,
    HardLabelProtocolError,
    QueryBudgetExceeded,
)


class ConstantModel:
    def predict(self, text: str) -> str:
        return "accepted" if text else "empty"


class OracleTests(unittest.TestCase):
    def test_returns_only_labels_and_accounts_exactly(self) -> None:
        oracle = BudgetedOracle(
            ConstantModel(), 2, valid_labels={"accepted", "empty"}
        )

        self.assertEqual(oracle.query("sample"), "accepted")
        self.assertEqual(oracle.query(""), "empty")
        self.assertEqual(oracle.stats().used, 2)
        self.assertEqual(oracle.remaining, 0)
        with self.assertRaises(QueryBudgetExceeded):
            oracle.query("third")
        self.assertEqual(oracle.query_count, 2)

    def test_callable_models_are_supported(self) -> None:
        oracle = BudgetedOracle(lambda text: 1 if text else 0, 1)
        self.assertEqual(oracle.query("x"), 1)

    def test_probability_like_output_is_rejected_and_counted(self) -> None:
        oracle = BudgetedOracle(lambda text: [0.1, 0.9], 1)  # type: ignore[arg-type]
        with self.assertRaises(HardLabelProtocolError):
            oracle.query("sample")
        self.assertEqual(oracle.queries_used, 1)

    def test_unknown_label_is_rejected(self) -> None:
        oracle = BudgetedOracle(lambda text: "other", 1, valid_labels={"yes", "no"})
        with self.assertRaises(HardLabelProtocolError):
            oracle.query("sample")

    def test_invalid_budget_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            BudgetedOracle(ConstantModel(), -1)
        with self.assertRaises(TypeError):
            BudgetedOracle(ConstantModel(), True)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
