"""Deterministic greedy substitution attack for a hard-label oracle."""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from .oracle import BudgetedOracle, Label, QueryBudgetExceeded
from .tokenization import Tokenizer, WhitespaceTokenizer
from .wir import (
    SubstitutionProvider,
    TokenImportance,
    WIRMethod,
    rank_tokens,
)


@dataclass(frozen=True, slots=True)
class AttackConstraints:
    """Simple, explicit admissibility constraints for substitutions.

    ``max_change_ratio`` and ``max_changed_tokens`` are both upper bounds; the
    tighter one applies.  ``require_single_token`` prevents a lexical candidate
    from silently inserting several tokens.  ``preserve_alphabetic`` prevents
    replacements such as a word by punctuation (and vice versa).
    """

    max_changed_tokens: int | None = None
    max_change_ratio: float = 1.0
    require_single_token: bool = True
    preserve_alphabetic: bool = True

    def __post_init__(self) -> None:
        if self.max_changed_tokens is not None:
            if (
                isinstance(self.max_changed_tokens, bool)
                or not isinstance(self.max_changed_tokens, int)
                or self.max_changed_tokens < 0
            ):
                raise ValueError("max_changed_tokens must be a non-negative integer")
        if (
            isinstance(self.max_change_ratio, bool)
            or not isinstance(self.max_change_ratio, (int, float))
            or not math.isfinite(float(self.max_change_ratio))
            or not 0.0 <= float(self.max_change_ratio) <= 1.0
        ):
            raise ValueError("max_change_ratio must be a finite value in [0, 1]")

    def change_limit(self, token_count: int) -> int:
        """Return the maximum number of positions allowed to change."""

        ratio_limit = math.floor(float(self.max_change_ratio) * token_count)
        if self.max_changed_tokens is None:
            return ratio_limit
        return min(ratio_limit, self.max_changed_tokens)

    def allows(self, source: str, candidate: str, tokenizer: Tokenizer) -> bool:
        """Return whether one candidate satisfies local lexical constraints."""

        if not candidate or candidate == source:
            return False
        if self.require_single_token and len(tokenizer.tokenize(candidate)) != 1:
            return False
        if self.preserve_alphabetic and source.isalpha() != candidate.isalpha():
            return False
        return True


@dataclass(frozen=True, slots=True)
class Substitution:
    """One accepted edit in the greedy trajectory."""

    index: int
    original: str
    replacement: str


@dataclass(frozen=True, slots=True)
class AttackMetrics:
    """Metrics needed for reproducible hard-label attack reporting."""

    token_count: int
    changed_tokens: int
    change_rate: float
    queries: int
    ranking_queries: int
    attack_queries: int
    candidates_evaluated: int


@dataclass(frozen=True, slots=True)
class AttackResult:
    """Complete immutable outcome of one attack attempt."""

    original_text: str
    adversarial_text: str
    original_label: Label
    final_label: Label
    success: bool
    targeted: bool
    target_label: Label | None
    edits: tuple[Substitution, ...]
    ranking: tuple[TokenImportance, ...]
    reason: str
    metrics: AttackMetrics


class GreedyHardLabelAttack:
    """Greedily change WIR-ranked tokens and stop at the first success.

    For each ranked position, all admissible candidates are tested in provider
    order.  The first successful candidate is returned.  If none succeeds, the
    first admissible candidate is retained as the deterministic greedy step and
    the next ranked position is visited.  Stopping on the first success gives
    the smallest number of edits along this deterministic greedy trajectory;
    it does not claim a globally minimal adversarial example.
    """

    def __init__(
        self,
        oracle: BudgetedOracle,
        substitutions: SubstitutionProvider,
        *,
        tokenizer: Tokenizer | None = None,
        wir_method: WIRMethod | str = WIRMethod.DELETION,
        constraints: AttackConstraints | None = None,
        mask_token: str = "[MASK]",
    ) -> None:
        if not callable(substitutions):
            raise TypeError("substitutions must be callable")
        self.oracle = oracle
        self.substitutions = substitutions
        self.tokenizer = tokenizer or WhitespaceTokenizer()
        self.wir_method = WIRMethod(wir_method)
        self.constraints = constraints or AttackConstraints()
        self.mask_token = mask_token

    def _candidates(
        self, source: str, index: int, tokens: Sequence[str]
    ) -> tuple[str, ...]:
        candidates: list[str] = []
        seen = {source}
        raw: Iterable[str] = self.substitutions(source, index, tokens)
        for candidate in raw:
            if not isinstance(candidate, str):
                raise TypeError("substitution candidates must be strings")
            if candidate in seen:
                continue
            seen.add(candidate)
            if self.constraints.allows(source, candidate, self.tokenizer):
                candidates.append(candidate)
        return tuple(candidates)

    @staticmethod
    def _is_success(
        label: Label, original_label: Label, target_label: Label | None
    ) -> bool:
        return label == target_label if target_label is not None else label != original_label

    def run(self, text: str, *, target_label: Label | None = None) -> AttackResult:
        """Attempt an untargeted (default) or targeted substitution attack."""

        if not isinstance(text, str):
            raise TypeError("text must be a string")
        query_start = self.oracle.queries_used
        original_label = self.oracle.query(text)
        tokens = self.tokenizer.tokenize(text)
        original_tokens = tuple(tokens)
        ranking: list[TokenImportance] = []
        ranking_queries = 0
        candidates_evaluated = 0
        edits: list[Substitution] = []
        final_label = original_label

        def finish(success: bool, reason: str) -> AttackResult:
            query_delta = self.oracle.queries_used - query_start
            changed = len(edits)
            metrics = AttackMetrics(
                token_count=len(original_tokens),
                changed_tokens=changed,
                change_rate=(changed / len(original_tokens) if original_tokens else 0.0),
                queries=query_delta,
                ranking_queries=ranking_queries,
                attack_queries=max(0, query_delta - 1 - ranking_queries),
                candidates_evaluated=candidates_evaluated,
            )
            return AttackResult(
                original_text=text,
                adversarial_text=self.tokenizer.detokenize(tokens),
                original_label=original_label,
                final_label=final_label,
                success=success,
                targeted=target_label is not None,
                target_label=target_label,
                edits=tuple(edits),
                ranking=tuple(ranking),
                reason=reason,
                metrics=metrics,
            )

        if target_label is not None and original_label == target_label:
            return finish(True, "already_satisfied")
        if not tokens:
            return finish(False, "no_tokens")

        ranking_start = self.oracle.queries_used
        try:
            ranking = rank_tokens(
                original_tokens,
                original_label,
                self.oracle,
                method=self.wir_method,
                tokenizer=self.tokenizer,
                substitutions=self.substitutions,
                mask_token=self.mask_token,
            )
        except QueryBudgetExceeded:
            ranking_queries = self.oracle.queries_used - ranking_start
            return finish(False, "query_budget_exhausted")
        ranking_queries = self.oracle.queries_used - ranking_start

        change_limit = self.constraints.change_limit(len(tokens))
        if change_limit == 0:
            return finish(False, "constraints_exhausted")

        for importance in ranking:
            if len(edits) >= change_limit:
                return finish(False, "constraints_exhausted")

            index = importance.index
            source = tokens[index]
            candidates = self._candidates(source, index, tuple(tokens))
            if not candidates:
                continue

            fallback: tuple[str, Label] | None = None
            for candidate in candidates:
                trial = list(tokens)
                trial[index] = candidate
                try:
                    candidate_label = self.oracle.query(self.tokenizer.detokenize(trial))
                except QueryBudgetExceeded:
                    return finish(False, "query_budget_exhausted")
                candidates_evaluated += 1
                if self._is_success(candidate_label, original_label, target_label):
                    tokens[index] = candidate
                    edits.append(Substitution(index, original_tokens[index], candidate))
                    final_label = candidate_label
                    return finish(True, "success")
                if fallback is None:
                    fallback = (candidate, candidate_label)

            # Hard labels provide no meaningful preference among unsuccessful
            # candidates, so the provider's first candidate is the stable rule.
            if fallback is not None:
                candidate, candidate_label = fallback
                tokens[index] = candidate
                edits.append(Substitution(index, original_tokens[index], candidate))
                final_label = candidate_label

        return finish(False, "search_exhausted")


def greedy_attack(
    text: str,
    oracle: BudgetedOracle,
    substitutions: SubstitutionProvider,
    *,
    target_label: Label | None = None,
    tokenizer: Tokenizer | None = None,
    wir_method: WIRMethod | str = WIRMethod.DELETION,
    constraints: AttackConstraints | None = None,
    mask_token: str = "[MASK]",
) -> AttackResult:
    """Functional convenience wrapper around :class:`GreedyHardLabelAttack`."""

    return GreedyHardLabelAttack(
        oracle,
        substitutions,
        tokenizer=tokenizer,
        wir_method=wir_method,
        constraints=constraints,
        mask_token=mask_token,
    ).run(text, target_label=target_label)

