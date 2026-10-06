from __future__ import annotations

import unittest

from pfe_hla.fulltext import normalize_text, verify_evidence_in_pages


class EvidenceVerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pages = [
            "Introduction. The attack uses only the final class label.",
            "Results\nAccuracy reached 91.20% on the held-out set.",
        ]

    def test_exact_quote_is_found_on_the_correct_page(self) -> None:
        match = verify_evidence_in_pages(
            self.pages,
            quote="The attack uses only the final class label.",
            value_text="91.20%",
        )
        self.assertEqual(match.status, "exact_quote")
        self.assertEqual(match.page_number, 1)

    def test_value_only_is_a_weaker_status(self) -> None:
        match = verify_evidence_in_pages(
            self.pages,
            quote="A sentence that does not exist.",
            value_text="91.20%",
        )
        self.assertEqual(match.status, "value_only")
        self.assertEqual(match.page_number, 2)

    def test_missing_evidence_is_not_silently_accepted(self) -> None:
        match = verify_evidence_in_pages(self.pages, quote="unsupported claim")
        self.assertEqual(match.status, "not_found")
        self.assertIsNone(match.page_number)

    def test_normalization_handles_line_break_hyphenation(self) -> None:
        self.assertEqual(normalize_text("adver-\n sarial"), "adversarial")


if __name__ == "__main__":
    unittest.main()
