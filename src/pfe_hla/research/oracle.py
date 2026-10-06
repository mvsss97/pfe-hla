"""Strict hard-label oracle and query-budget accounting.

The research code deliberately exposes no confidence, logit, probability, or
gradient.  A query has the mathematical form ``f(x) -> y`` where ``x`` is a
text and ``y`` is one scalar class identifier.
"""

from __future__ import annotations

from collections.abc import Callable, Collection
from dataclasses import dataclass
from threading import Lock
from typing import Protocol, TypeAlias, runtime_checkable

Label: TypeAlias = str | int
"""A scalar class identifier accepted by the strict protocol."""


@runtime_checkable
class HardLabelModel(Protocol):
    """Minimal interface implemented by a hard-label text classifier."""

    def predict(self, text: str) -> Label:
        """Return exactly one class label for ``text``."""


class QueryBudgetExceeded(RuntimeError):
    """Raised before a model call that would exceed the configured budget."""


class HardLabelProtocolError(TypeError):
    """Raised when a model leaks a non-scalar output through the protocol."""


@dataclass(frozen=True, slots=True)
class QueryStats:
    """Immutable snapshot of an oracle's query accounting."""

    used: int
    budget: int
    remaining: int


class BudgetedOracle:
    """Enforce a strict hard-label interface and an exact query budget.

    Parameters
    ----------
    model:
        An object exposing ``predict(text)`` or a callable with the same
        semantics.  The returned value must be a :class:`str` or :class:`int`.
    max_queries:
        Maximum number of calls sent to the underlying model.  A malformed
        model response still consumes a query because the call was made.
    valid_labels:
        Optional finite label set.  Supplying it catches accidental or unknown
        class identifiers without revealing any extra model information.

    Notes
    -----
    Budget reservation is protected by a lock, so concurrent callers cannot
    collectively exceed ``max_queries``.  Thread safety of the wrapped model
    itself remains the model owner's responsibility.
    """

    def __init__(
        self,
        model: HardLabelModel | Callable[[str], Label],
        max_queries: int,
        *,
        valid_labels: Collection[Label] | None = None,
    ) -> None:
        if isinstance(max_queries, bool) or not isinstance(max_queries, int):
            raise TypeError("max_queries must be an integer")
        if max_queries < 0:
            raise ValueError("max_queries must be non-negative")
        if not callable(model) and not callable(getattr(model, "predict", None)):
            raise TypeError("model must be callable or expose predict(text)")

        checked_labels: frozenset[Label] | None = None
        if valid_labels is not None:
            values = tuple(valid_labels)
            if not values:
                raise ValueError("valid_labels cannot be empty")
            for label in values:
                self._validate_label(label)
            checked_labels = frozenset(values)

        self._model = model
        self._max_queries = max_queries
        self._valid_labels = checked_labels
        self._queries_used = 0
        self._lock = Lock()

    @staticmethod
    def _validate_label(label: object) -> None:
        # Exact scalar types keep arrays, score tuples, dictionaries, and
        # custom probability wrappers out of the hard-label boundary.
        if type(label) not in (str, int):
            raise HardLabelProtocolError(
                "hard-label models must return one str or int class label; "
                f"received {type(label).__name__}"
            )

    def query(self, text: str) -> Label:
        """Query the classifier once and return only its scalar label."""

        if not isinstance(text, str):
            raise TypeError("text must be a string")

        # Reserve the query before invoking user/model code.  Consequently a
        # failing model call is truthfully accounted for as an attempted query.
        with self._lock:
            if self._queries_used >= self._max_queries:
                raise QueryBudgetExceeded(
                    f"query budget exhausted ({self._queries_used}/{self._max_queries})"
                )
            self._queries_used += 1

        predictor = getattr(self._model, "predict", None)
        label = predictor(text) if callable(predictor) else self._model(text)  # type: ignore[operator]
        self._validate_label(label)
        if self._valid_labels is not None and label not in self._valid_labels:
            raise HardLabelProtocolError(f"unknown hard label: {label!r}")
        return label  # type: ignore[return-value]

    @property
    def max_queries(self) -> int:
        """Configured maximum number of underlying model calls."""

        return self._max_queries

    @property
    def queries_used(self) -> int:
        """Number of model calls already consumed."""

        with self._lock:
            return self._queries_used

    @property
    def query_count(self) -> int:
        """Alias for :attr:`queries_used`, useful in experiment tables."""

        return self.queries_used

    @property
    def remaining(self) -> int:
        """Number of additional calls that can still be issued."""

        with self._lock:
            return self._max_queries - self._queries_used

    def stats(self) -> QueryStats:
        """Return a consistent, immutable accounting snapshot."""

        with self._lock:
            used = self._queries_used
            return QueryStats(used, self._max_queries, self._max_queries - used)
