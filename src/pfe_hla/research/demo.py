"""Offline lexicon model and substitutions for a zero-dependency demo.

This module is a mock experiment fixture, not an evaluation model.  It makes
the strict protocol and metrics executable without network access, credentials,
Telegram, or a third-party machine-learning package.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field

from .attack import AttackConstraints, AttackResult, greedy_attack
from .oracle import BudgetedOracle, Label
from .tokenization import Tokenizer, WhitespaceTokenizer
from .wir import WIRMethod

DEFAULT_POSITIVE = frozenset(
    {"accurate", "good", "reliable", "robust", "safe", "secure", "useful"}
)
DEFAULT_NEGATIVE = frozenset(
    {"bad", "fragile", "harmful", "inaccurate", "poor", "unsafe", "useless"}
)

DEFAULT_SUBSTITUTIONS: dict[str, tuple[str, ...]] = {
    "accurate": ("inaccurate", "poor"),
    "good": ("bad", "poor"),
    "reliable": ("fragile",),
    "robust": ("fragile", "unsafe"),
    "safe": ("unsafe", "harmful"),
    "secure": ("unsafe",),
    "useful": ("useless", "harmful"),
}


@dataclass(slots=True)
class LexiconHardLabelModel:
    """Tiny deterministic classifier whose public prediction is one label."""

    positive_words: frozenset[str] = DEFAULT_POSITIVE
    negative_words: frozenset[str] = DEFAULT_NEGATIVE
    tokenizer: Tokenizer = field(default_factory=WhitespaceTokenizer)

    def predict(self, text: str) -> Label:
        words = [
            token.casefold().strip(".,;:!?()[]{}\"'")
            for token in self.tokenizer.tokenize(text)
        ]
        positive = sum(word in self.positive_words for word in words)
        negative = sum(word in self.negative_words for word in words)
        if positive > negative:
            return "positive"
        if negative > positive:
            return "negative"
        return "neutral"


class MappingSubstitutions:
    """Ordered lexicon-backed substitution provider."""

    def __init__(self, mapping: Mapping[str, Iterable[str]]) -> None:
        self._mapping = {
            str(key).casefold(): tuple(str(value) for value in values)
            for key, values in mapping.items()
        }

    def __call__(
        self, token: str, index: int, tokens: Sequence[str]
    ) -> tuple[str, ...]:
        del index, tokens
        return self._mapping.get(token.casefold(), ())


def make_demo_oracle(max_queries: int = 100) -> BudgetedOracle:
    """Build the mock model behind a strict finite-budget oracle."""

    return BudgetedOracle(
        LexiconHardLabelModel(),
        max_queries,
        valid_labels={"positive", "neutral", "negative"},
    )


def run_demo(
    text: str = "the model is good and robust",
    *,
    max_queries: int = 100,
    wir_method: WIRMethod | str = WIRMethod.NEIGHBORHOOD,
) -> AttackResult:
    """Run one reproducible untargeted mock attack and return its result."""

    oracle = make_demo_oracle(max_queries)
    provider = MappingSubstitutions(DEFAULT_SUBSTITUTIONS)
    return greedy_attack(
        text,
        oracle,
        provider,
        wir_method=wir_method,
        constraints=AttackConstraints(max_change_ratio=0.5),
    )
