from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from pfe_hla.research.demo import run_demo  # noqa: E402


class DemoTests(unittest.TestCase):
    def test_offline_demo_produces_an_adversarial_label(self) -> None:
        result = run_demo()

        self.assertTrue(result.success)
        self.assertEqual(result.original_label, "positive")
        self.assertNotEqual(result.final_label, result.original_label)
        self.assertGreaterEqual(result.metrics.changed_tokens, 1)
        self.assertLessEqual(result.metrics.queries, 100)


if __name__ == "__main__":
    unittest.main()
