"""Reproducible JSONL benchmark runner for hard-label WIR comparisons.

Initial filtering is performed once per dataset example.  Only examples whose
initial prediction equals the reference label enter the attack denominator.
Each WIR method then receives a fresh oracle with the same query budget and a
substitution provider initialized with the same per-example seed.

The reported attack-success rate is therefore

``ASR = successful attacks / initially correctly classified examples``.

If that denominator is zero, ASR is ``None`` in Python and ``null`` in JSON,
rather than the misleading value ``0``.  Screening queries are reported
separately and are not silently charged to one WIR method.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from .attack import AttackConstraints, AttackResult, GreedyHardLabelAttack
from .oracle import BudgetedOracle, HardLabelModel, Label
from .tokenization import Tokenizer, WhitespaceTokenizer
from .wir import SubstitutionProvider, WIRMethod


@runtime_checkable
class SubstitutionFactory(Protocol):
    """Build an equivalent candidate provider from a reproducible seed."""

    def __call__(self, seed: int) -> SubstitutionProvider:
        """Return a fresh provider initialized with ``seed``."""


@dataclass(frozen=True, slots=True)
class BenchmarkExample:
    """One labeled JSONL example."""

    example_id: str
    text: str
    true_label: Label

    def __post_init__(self) -> None:
        if not isinstance(self.example_id, str):
            raise TypeError("example_id must be a string")
        if not self.example_id:
            raise ValueError("example_id cannot be empty")
        if not isinstance(self.text, str):
            raise TypeError("text must be a string")
        if type(self.true_label) not in (str, int):
            raise TypeError("true_label must be a str or int")


@dataclass(frozen=True, slots=True)
class BenchmarkConfig:
    """Shared experimental settings applied identically to every method."""

    methods: tuple[WIRMethod | str, ...] = (
        WIRMethod.DELETION,
        WIRMethod.MASKING,
        WIRMethod.NEIGHBORHOOD,
    )
    query_budget: int = 100
    seed: int = 0
    constraints: AttackConstraints = field(default_factory=AttackConstraints)
    mask_token: str = "[MASK]"

    def __post_init__(self) -> None:
        normalized = tuple(WIRMethod(method) for method in self.methods)
        if not normalized:
            raise ValueError("at least one WIR method is required")
        if len(set(normalized)) != len(normalized):
            raise ValueError("WIR methods must be unique")
        if (
            isinstance(self.query_budget, bool)
            or not isinstance(self.query_budget, int)
            or self.query_budget < 1
        ):
            raise ValueError("query_budget must be an integer of at least 1")
        if isinstance(self.seed, bool) or not isinstance(self.seed, int):
            raise TypeError("seed must be an integer")
        if not isinstance(self.mask_token, str) or not self.mask_token:
            raise ValueError("mask_token must be a non-empty string")
        object.__setattr__(self, "methods", normalized)


@dataclass(frozen=True, slots=True)
class MethodRun:
    """One attack method's result for one eligible example."""

    method: str
    seed: int
    baseline_consistent: bool
    attack: AttackResult

    def as_dict(self) -> dict[str, Any]:
        return {
            "method": self.method,
            "seed": self.seed,
            "baseline_consistent": self.baseline_consistent,
            "attack": asdict(self.attack),
        }


@dataclass(frozen=True, slots=True)
class ExampleBenchmarkResult:
    """Filtering decision and all method runs for a dataset example."""

    example_id: str
    text: str
    true_label: Label
    initial_label: Label
    eligible: bool
    skip_reason: str | None
    screening_queries: int
    methods: tuple[MethodRun, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "record_type": "example",
            "example_id": self.example_id,
            "text": self.text,
            "true_label": self.true_label,
            "initial_label": self.initial_label,
            "eligible": self.eligible,
            "skip_reason": self.skip_reason,
            "screening_queries": self.screening_queries,
            "methods": [method.as_dict() for method in self.methods],
        }


@dataclass(frozen=True, slots=True)
class MethodAggregate:
    """Aggregate with explicit denominators and nullable empty-set means."""

    method: str
    total_examples: int
    eligible_examples: int
    filtered_initially_misclassified: int
    attacks_attempted: int
    successes: int
    asr_numerator: int
    asr_denominator: int
    asr: float | None
    total_attack_queries: int
    mean_queries: float | None
    mean_changed_tokens: float | None
    mean_changed_tokens_successful: float | None
    mean_change_rate_successful: float | None
    query_budget_exhaustions: int
    inconsistent_baselines: int

    def as_dict(self) -> dict[str, Any]:
        return {"record_type": "aggregate", **asdict(self)}


@dataclass(frozen=True, slots=True)
class BenchmarkReport:
    """Complete benchmark output suitable for JSONL serialization."""

    seed: int
    query_budget: int
    methods: tuple[str, ...]
    constraints: AttackConstraints
    mask_token: str
    total_examples: int
    eligible_examples: int
    filtered_initially_misclassified: int
    screening_queries: int
    examples: tuple[ExampleBenchmarkResult, ...]
    aggregates: tuple[MethodAggregate, ...]

    def records(self) -> tuple[dict[str, Any], ...]:
        """Return metadata, per-example records, then aggregate records."""

        metadata = {
            "record_type": "metadata",
            "seed": self.seed,
            "query_budget_per_method": self.query_budget,
            "methods": list(self.methods),
            "attack_constraints": asdict(self.constraints),
            "mask_token": self.mask_token,
            "total_examples": self.total_examples,
            "eligible_examples": self.eligible_examples,
            "filtered_initially_misclassified": self.filtered_initially_misclassified,
            "screening_queries": self.screening_queries,
            "asr_denominator_definition": "initially_correctly_classified_examples",
            "seed_derivation": "blake2s-32(master_seed NUL example_id)",
        }
        return (
            metadata,
            *(example.as_dict() for example in self.examples),
            *(aggregate.as_dict() for aggregate in self.aggregates),
        )


def _derived_seed(master_seed: int, example_id: str) -> int:
    payload = f"{master_seed}\0{example_id}".encode()
    return int.from_bytes(hashlib.blake2s(payload, digest_size=4).digest(), "big")


def _mean(values: Sequence[int | float]) -> float | None:
    return sum(values) / len(values) if values else None


class BenchmarkRunner:
    """Run fair, query-limited WIR comparisons over labeled examples.

    For stochastic candidate generation, pass ``substitution_factory`` and use
    its integer argument to initialize a fresh provider.  Every method receives
    the same derived seed for a given example.  A direct ``substitutions``
    provider is convenient for deterministic/stateless lexicons.
    """

    def __init__(
        self,
        model: HardLabelModel | Callable[[str], Label],
        *,
        substitutions: SubstitutionProvider | None = None,
        substitution_factory: SubstitutionFactory | None = None,
        config: BenchmarkConfig | None = None,
        tokenizer: Tokenizer | None = None,
        valid_labels: Sequence[Label] | None = None,
    ) -> None:
        if (substitutions is None) == (substitution_factory is None):
            raise ValueError(
                "provide exactly one of substitutions or substitution_factory"
            )
        self.model = model
        self.substitutions = substitutions
        self.substitution_factory = substitution_factory
        self.config = config or BenchmarkConfig()
        self.tokenizer = tokenizer or WhitespaceTokenizer()
        self.valid_labels = tuple(valid_labels) if valid_labels is not None else None

    def _provider(self, seed: int) -> SubstitutionProvider:
        if self.substitution_factory is not None:
            provider = self.substitution_factory(seed)
            if not callable(provider):
                raise TypeError("substitution_factory must return a callable provider")
            return provider
        assert self.substitutions is not None
        return self.substitutions

    def run(self, examples: Iterable[BenchmarkExample]) -> BenchmarkReport:
        """Filter initially wrong examples, attack eligible ones, and aggregate."""

        dataset = tuple(examples)
        identifiers = [example.example_id for example in dataset]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("benchmark example identifiers must be unique")

        screening_oracle = BudgetedOracle(
            self.model,
            len(dataset),
            valid_labels=self.valid_labels,
        )
        example_results: list[ExampleBenchmarkResult] = []

        for example in dataset:
            initial_label = screening_oracle.query(example.text)
            eligible = initial_label == example.true_label
            if not eligible:
                example_results.append(
                    ExampleBenchmarkResult(
                        example_id=example.example_id,
                        text=example.text,
                        true_label=example.true_label,
                        initial_label=initial_label,
                        eligible=False,
                        skip_reason="initial_misclassification",
                        screening_queries=1,
                        methods=(),
                    )
                )
                continue

            example_seed = _derived_seed(self.config.seed, example.example_id)
            method_runs: list[MethodRun] = []
            for method in self.config.methods:
                provider = self._provider(example_seed)
                oracle = BudgetedOracle(
                    self.model,
                    self.config.query_budget,
                    valid_labels=self.valid_labels,
                )
                attack = GreedyHardLabelAttack(
                    oracle,
                    provider,
                    tokenizer=self.tokenizer,
                    wir_method=method,
                    constraints=self.config.constraints,
                    mask_token=self.config.mask_token,
                ).run(example.text)
                method_runs.append(
                    MethodRun(
                        method=method.value,
                        seed=example_seed,
                        baseline_consistent=attack.original_label == initial_label,
                        attack=attack,
                    )
                )

            example_results.append(
                ExampleBenchmarkResult(
                    example_id=example.example_id,
                    text=example.text,
                    true_label=example.true_label,
                    initial_label=initial_label,
                    eligible=True,
                    skip_reason=None,
                    screening_queries=1,
                    methods=tuple(method_runs),
                )
            )

        eligible_count = sum(result.eligible for result in example_results)
        aggregates = tuple(
            self._aggregate(method, tuple(example_results), eligible_count)
            for method in self.config.methods
        )
        return BenchmarkReport(
            seed=self.config.seed,
            query_budget=self.config.query_budget,
            methods=tuple(method.value for method in self.config.methods),
            constraints=self.config.constraints,
            mask_token=self.config.mask_token,
            total_examples=len(dataset),
            eligible_examples=eligible_count,
            filtered_initially_misclassified=len(dataset) - eligible_count,
            screening_queries=screening_oracle.queries_used,
            examples=tuple(example_results),
            aggregates=aggregates,
        )

    @staticmethod
    def _aggregate(
        method: WIRMethod,
        examples: tuple[ExampleBenchmarkResult, ...],
        eligible_count: int,
    ) -> MethodAggregate:
        runs = [
            run
            for example in examples
            for run in example.methods
            if run.method == method.value
        ]
        successful = [
            run for run in runs if run.baseline_consistent and run.attack.success
        ]
        successes = len(successful)
        return MethodAggregate(
            method=method.value,
            total_examples=len(examples),
            eligible_examples=eligible_count,
            filtered_initially_misclassified=len(examples) - eligible_count,
            attacks_attempted=len(runs),
            successes=successes,
            asr_numerator=successes,
            asr_denominator=eligible_count,
            asr=successes / eligible_count if eligible_count else None,
            total_attack_queries=sum(run.attack.metrics.queries for run in runs),
            mean_queries=_mean([run.attack.metrics.queries for run in runs]),
            mean_changed_tokens=_mean(
                [run.attack.metrics.changed_tokens for run in runs]
            ),
            mean_changed_tokens_successful=_mean(
                [run.attack.metrics.changed_tokens for run in successful]
            ),
            mean_change_rate_successful=_mean(
                [run.attack.metrics.change_rate for run in successful]
            ),
            query_budget_exhaustions=sum(
                run.attack.reason == "query_budget_exhausted" for run in runs
            ),
            inconsistent_baselines=sum(not run.baseline_consistent for run in runs),
        )


def read_examples_jsonl(
    path: str | Path,
    *,
    id_field: str = "id",
    text_field: str = "text",
    label_field: str = "label",
) -> tuple[BenchmarkExample, ...]:
    """Read strict ``id``, ``text``, ``label`` records from a UTF-8 JSONL file."""

    examples: list[BenchmarkExample] = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            if not raw_line.strip():
                continue
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON on line {line_number}: {exc.msg}") from exc
            if not isinstance(record, Mapping):
                raise ValueError(f"JSONL line {line_number} must contain an object")
            missing = [
                field
                for field in (id_field, text_field, label_field)
                if field not in record
            ]
            if missing:
                raise ValueError(
                    f"JSONL line {line_number} misses field(s): {', '.join(missing)}"
                )
            examples.append(
                BenchmarkExample(
                    example_id=str(record[id_field]),
                    text=record[text_field],
                    true_label=record[label_field],
                )
            )
    return tuple(examples)


def write_report_jsonl(
    report: BenchmarkReport,
    path: str | Path,
    *,
    provenance: Mapping[str, Any] | None = None,
) -> Path:
    """Write deterministic metadata/example/aggregate records as UTF-8 JSONL."""

    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="\n") as handle:
        for index, record in enumerate(report.records()):
            if index == 0 and provenance is not None:
                record = {**record, "provenance": dict(provenance)}
            handle.write(
                json.dumps(
                    record,
                    ensure_ascii=False,
                    sort_keys=True,
                    allow_nan=False,
                )
            )
            handle.write("\n")
    return destination


def run_jsonl_benchmark(
    input_path: str | Path,
    output_path: str | Path,
    model: HardLabelModel | Callable[[str], Label],
    *,
    substitutions: SubstitutionProvider | None = None,
    substitution_factory: SubstitutionFactory | None = None,
    config: BenchmarkConfig | None = None,
    tokenizer: Tokenizer | None = None,
    valid_labels: Sequence[Label] | None = None,
    provenance: Mapping[str, Any] | None = None,
) -> BenchmarkReport:
    """Convenience entry point designed to plug directly into the main CLI."""

    examples = read_examples_jsonl(input_path)
    report = BenchmarkRunner(
        model,
        substitutions=substitutions,
        substitution_factory=substitution_factory,
        config=config,
        tokenizer=tokenizer,
        valid_labels=valid_labels,
    ).run(examples)
    write_report_jsonl(report, output_path, provenance=provenance)
    return report
