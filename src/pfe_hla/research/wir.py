"""Word-importance ranking (WIR) using hard labels only.

Let ``y = f(x)`` be the original label.  With no confidence scores available,
deletion and masking use the binary decision-change indicator

``I_i = 1[f(x^(i)) != y]``.

Neighborhood voting evaluates a finite substitution set ``N_i`` and uses

``I_i = (1 / |N_i|) * sum_{z in N_i} 1[f(x[i <- z]) != y]``.

Thus every value is reproducible from labels alone.  Equal scores are ordered
by increasing token index, which provides deterministic tie-breaking.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, runtime_checkable

from .oracle import BudgetedOracle, Label
from .tokenization import Tokenizer, WhitespaceTokenizer


@runtime_checkable
class SubstitutionProvider(Protocol):
    """Return ordered candidate replacements for one token position."""

    def __call__(
        self, token: str, index: int, tokens: Sequence[str]
    ) -> Iterable[str]:
        """Yield candidates; provider order is used as a stable tie-breaker."""


class WIRMethod(StrEnum):
    """Supported hard-label word-importance estimators."""

    DELETION = "deletion"
    MASKING = "masking"
    NEIGHBORHOOD = "neighborhood"


@dataclass(frozen=True, slots=True)
class TokenImportance:
    """Measured importance of one original token."""

    index: int
    token: str
    score: float
    changed_votes: int
    observations: int


def _ordered(items: list[TokenImportance]) -> list[TokenImportance]:
    """Sort descending by score, then ascending by original position."""

    return sorted(items, key=lambda item: (-item.score, item.index))


def _checked_tokens(tokens: Sequence[str]) -> tuple[str, ...]:
    if isinstance(tokens, (str, bytes)):
        raise TypeError("tokens must be a sequence, not a string")
    values = tuple(tokens)
    if any(not isinstance(token, str) for token in values):
        raise TypeError("every token must be a string")
    return values


def deletion_wir(
    tokens: Sequence[str],
    original_label: Label,
    oracle: BudgetedOracle,
    *,
    tokenizer: Tokenizer | None = None,
) -> list[TokenImportance]:
    """Rank tokens by whether deleting each token changes the decision."""

    values = _checked_tokens(tokens)
    codec = tokenizer or WhitespaceTokenizer()
    measurements: list[TokenImportance] = []
    for index, token in enumerate(values):
        perturbed = values[:index] + values[index + 1 :]
        changed = int(oracle.query(codec.detokenize(perturbed)) != original_label)
        measurements.append(TokenImportance(index, token, float(changed), changed, 1))
    return _ordered(measurements)


def masking_wir(
    tokens: Sequence[str],
    original_label: Label,
    oracle: BudgetedOracle,
    *,
    tokenizer: Tokenizer | None = None,
    mask_token: str = "[MASK]",
) -> list[TokenImportance]:
    """Rank tokens by replacing each position with one fixed mask token."""

    values = _checked_tokens(tokens)
    if not isinstance(mask_token, str) or not mask_token:
        raise ValueError("mask_token must be a non-empty string")
    codec = tokenizer or WhitespaceTokenizer()
    measurements: list[TokenImportance] = []
    for index, token in enumerate(values):
        perturbed = list(values)
        perturbed[index] = mask_token
        changed = int(oracle.query(codec.detokenize(perturbed)) != original_label)
        measurements.append(TokenImportance(index, token, float(changed), changed, 1))
    return _ordered(measurements)


def _unique_candidates(
    candidates: Iterable[str], original_token: str
) -> tuple[str, ...]:
    unique: list[str] = []
    seen = {original_token}
    for candidate in candidates:
        if not isinstance(candidate, str):
            raise TypeError("substitution candidates must be strings")
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        unique.append(candidate)
    return tuple(unique)


def neighborhood_voting_wir(
    tokens: Sequence[str],
    original_label: Label,
    oracle: BudgetedOracle,
    substitutions: SubstitutionProvider,
    *,
    tokenizer: Tokenizer | None = None,
) -> list[TokenImportance]:
    """Rank tokens by the fraction of neighbor labels voting for a change.

    A token with no valid neighbor receives score ``0`` with zero observations.
    Duplicate candidates and candidates equal to the source token are ignored,
    preserving the provider's first-occurrence order.
    """

    values = _checked_tokens(tokens)
    if not callable(substitutions):
        raise TypeError("substitutions must be callable")
    codec = tokenizer or WhitespaceTokenizer()
    measurements: list[TokenImportance] = []

    for index, token in enumerate(values):
        candidates = _unique_candidates(substitutions(token, index, values), token)
        changed_votes = 0
        for candidate in candidates:
            perturbed = list(values)
            perturbed[index] = candidate
            changed_votes += int(
                oracle.query(codec.detokenize(perturbed)) != original_label
            )
        observations = len(candidates)
        score = changed_votes / observations if observations else 0.0
        measurements.append(
            TokenImportance(index, token, score, changed_votes, observations)
        )
    return _ordered(measurements)


def rank_tokens(
    tokens: Sequence[str],
    original_label: Label,
    oracle: BudgetedOracle,
    *,
    method: WIRMethod | str = WIRMethod.DELETION,
    tokenizer: Tokenizer | None = None,
    substitutions: SubstitutionProvider | None = None,
    mask_token: str = "[MASK]",
) -> list[TokenImportance]:
    """Dispatch to one of the three hard-label WIR strategies."""

    selected = WIRMethod(method)
    if selected is WIRMethod.DELETION:
        return deletion_wir(tokens, original_label, oracle, tokenizer=tokenizer)
    if selected is WIRMethod.MASKING:
        return masking_wir(
            tokens,
            original_label,
            oracle,
            tokenizer=tokenizer,
            mask_token=mask_token,
        )
    if substitutions is None:
        raise ValueError("neighborhood WIR requires a substitution provider")
    return neighborhood_voting_wir(
        tokens,
        original_label,
        oracle,
        substitutions,
        tokenizer=tokenizer,
    )
