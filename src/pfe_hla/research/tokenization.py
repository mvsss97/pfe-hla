"""Small injectable tokenization boundary used by the experiments."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol, runtime_checkable


@runtime_checkable
class Tokenizer(Protocol):
    """Tokenizer contract required by WIR and attack algorithms."""

    def tokenize(self, text: str) -> list[str]:
        """Split a text into an ordered, mutable token list."""

    def detokenize(self, tokens: Sequence[str]) -> str:
        """Turn a token sequence back into model input text."""


class WhitespaceTokenizer:
    """Deterministic tokenizer based on whitespace.

    It is intentionally transparent for a first research prototype: tokens are
    ``text.split()`` and are reconstructed with one ASCII space.  Production
    experiments can inject a language- or model-specific implementation of
    :class:`Tokenizer` without changing the attack code.
    """

    def tokenize(self, text: str) -> list[str]:
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        return text.split()

    def detokenize(self, tokens: Sequence[str]) -> str:
        if isinstance(tokens, (str, bytes)):
            raise TypeError("tokens must be a sequence of token strings")
        values = list(tokens)
        if any(not isinstance(token, str) for token in values):
            raise TypeError("every token must be a string")
        return " ".join(values)
