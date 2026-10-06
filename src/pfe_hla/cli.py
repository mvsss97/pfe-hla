"""Command-line interface for the research companion."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import sys
import time
from dataclasses import asdict
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pfe_hla.collect import DEFAULT_QUERIES, collect_sources, invalidate_search_run
from pfe_hla.config import Settings
from pfe_hla.db import connect, init_database, transaction
from pfe_hla.english import due_words, format_word_card, record_review
from pfe_hla.export import export_public_state
from pfe_hla.fulltext import fetch_and_extract, verify_and_record_evidence
from pfe_hla.library import (
    deduplicate_by_normalized_title,
    duplicate_title_groups,
    list_papers,
    seed_library,
    utc_now,
)
from pfe_hla.prisma import compute_prisma_counts
from pfe_hla.screening import (
    apply_screening_decision,
    record_final_decision,
    reopen_paper,
    suggest_title_abstract_screening,
)
from pfe_hla.telegram import BotService, TelegramClient, TelegramError

ROOT = Path(__file__).resolve().parents[2]


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def _settings() -> Settings:
    return Settings.from_env(ROOT / ".env")


def _ensure_db(settings: Settings) -> None:
    init_database(settings.database)


def command_init(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    print(f"Database ready: {settings.database}")
    if args.seed:
        with transaction(settings.database) as connection:
            result = seed_library(
                connection, ROOT / "data/seed_papers.json", ROOT / "data/seed_vocabulary.json"
            )
        print(f"Seeded {result['papers']} papers and {result['vocabulary']} vocabulary terms.")
    return 0


def command_seed(_args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    with transaction(settings.database) as connection:
        result = seed_library(
            connection, ROOT / "data/seed_papers.json", ROOT / "data/seed_vocabulary.json"
        )
    print(json.dumps(result, ensure_ascii=False))
    return 0


def command_collect(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    queries = tuple(args.query) if args.query else DEFAULT_QUERIES
    had_error = False
    with transaction(settings.database) as connection:
        for result in collect_sources(
            connection,
            queries=queries,
            openalex_email=settings.openalex_email,
            sources=tuple(args.source),
            limit=args.limit,
            run_kind=args.run_kind,
        ):
            if result.skipped:
                state = "SKIPPED duplicate frozen query"
            else:
                state = f"ERROR {result.error}" if result.error else "OK"
            print(
                f"{result.source}: {result.query} -> {result.returned} hits, "
                f"{result.inserted} new [{result.run_kind}; {state}]"
            )
            had_error = had_error or bool(result.error)
    return 1 if had_error else 0


def command_papers(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    with transaction(settings.database) as connection:
        rows = list_papers(connection, status=args.status, limit=args.limit)
    for row in rows:
        print(
            f"#{row['id']:03d} [{row['status']:<10}] {row['publication_year'] or '?'} "
            f"{row['title']}"
        )
    return 0


def command_invalidate_run(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    try:
        with transaction(settings.database) as connection:
            removed = invalidate_search_run(
                connection, run_id=args.run_id, reason=args.reason
            )
    except (KeyError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(f"Search run #{args.run_id} invalidated; {removed} orphan paper(s) removed.")
    return 0


def command_dedupe(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    with transaction(settings.database) as connection:
        groups = duplicate_title_groups(connection)
        if not args.apply:
            for group in groups:
                print(" | ".join(f"#{row['id']} {row['title']}" for row in group))
            print(f"Found {len(groups)} duplicate-title group(s); rerun with --apply to merge.")
            return 0
        merged = deduplicate_by_normalized_title(connection)
        remaining = len(duplicate_title_groups(connection))
    print(
        f"Merged {merged} exact normalized-title duplicate(s); "
        f"{remaining} conflict group(s) require human review."
    )
    return 0


def command_suggestions(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    with transaction(settings.database) as connection:
        rows = list(
            connection.execute(
                """
                SELECT * FROM papers
                WHERE status IN ('identified','screened')
                  AND EXISTS (
                    SELECT 1 FROM paper_hits
                    JOIN search_runs ON search_runs.id=paper_hits.run_id
                    JOIN search_run_details ON search_run_details.run_id=search_runs.id
                    WHERE paper_hits.paper_id=papers.id
                      AND search_runs.status='ok'
                      AND search_run_details.run_kind='review'
                  )
                ORDER BY id LIMIT ?
                """,
                (args.limit,),
            )
        )
        for row in rows:
            suggestion = suggest_title_abstract_screening(row)
            print(
                f"#{row['id']:03d} {suggestion.decision:<9} {suggestion.reason_code or '--'} "
                f"[{suggestion.confidence}] {row['title']}\n    {suggestion.rationale}"
            )
            if args.apply_obvious_exclusions and (
                suggestion.decision == "exclude" and suggestion.confidence == "high"
            ):
                apply_screening_decision(
                    connection,
                    paper_id=int(row["id"]),
                    stage="title_abstract",
                    decision="exclude",
                    reason_code=suggestion.reason_code,
                    rationale=suggestion.rationale,
                    reviewer="deterministic-rule",
                )
    return 0


def command_screen(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    if args.decision == "exclude" and not args.code:
        print("An exclusion requires --code (for example E2).", file=sys.stderr)
        return 2
    with transaction(settings.database) as connection:
        exists = connection.execute(
            "SELECT 1 FROM papers WHERE id=?", (args.paper_id,)
        ).fetchone()
        if exists is None:
            print(f"Unknown paper #{args.paper_id}.", file=sys.stderr)
            return 2
        try:
            apply_screening_decision(
                connection,
                paper_id=args.paper_id,
                stage=args.stage,
                decision=args.decision,
                reason_code=args.code,
                rationale=args.reason,
                reviewer=args.reviewer,
            )
        except (KeyError, ValueError) as exc:
            print(str(exc), file=sys.stderr)
            return 2
    print(f"Screening decision recorded for paper #{args.paper_id}.")
    return 0


def command_decide(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    if args.decision == "reject" and not args.code:
        print("A rejection requires --code.", file=sys.stderr)
        return 2
    with transaction(settings.database) as connection:
        try:
            record_final_decision(
                connection,
                paper_id=args.paper_id,
                decision=args.decision,
                reason_code=args.code,
                note=args.note,
            )
        except (KeyError, ValueError) as exc:
            print(str(exc), file=sys.stderr)
            return 2
    print(f"Final decision recorded for paper #{args.paper_id}.")
    return 0


def command_reopen(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    try:
        with transaction(settings.database) as connection:
            reopen_paper(
                connection,
                paper_id=args.paper_id,
                target_status=args.to,
                rationale=args.reason,
                reviewer=args.reviewer,
            )
    except (KeyError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(f"Paper #{args.paper_id} reopened at stage {args.to}; history was preserved.")
    return 0


def command_stats(_args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    with transaction(settings.database) as connection:
        counts = compute_prisma_counts(connection)
    print(json.dumps(counts.as_dict(), ensure_ascii=False, indent=2))
    return 0


def command_words(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    with transaction(settings.database) as connection:
        rows = due_words(connection, limit=args.limit)
        for row in rows:
            card = format_word_card(row)
            for tag in ("<b>", "</b>", "<i>", "</i>"):
                card = card.replace(tag, "")
            print(f"#{row['id']} {card}\n")
    return 0


def command_review(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    with transaction(settings.database) as connection:
        schedule = record_review(
            connection, vocabulary_id=args.vocabulary_id, quality=args.quality
        )
    print(
        f"Next review in {schedule.interval_days} day(s); ease={schedule.ease:.2f}; "
        f"repetitions={schedule.repetitions}."
    )
    return 0


def _bot_service(settings: Settings, connection) -> BotService:
    if not settings.telegram_token:
        raise TelegramError("TELEGRAM_BOT_TOKEN is missing from .env")
    return BotService(connection, settings, TelegramClient(settings.telegram_token))


def command_bot_poll(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    try:
        with transaction(settings.database) as connection:
            service = _bot_service(settings, connection)
            if not args.watch:
                print(f"Processed {service.poll_once(timeout=args.timeout)} update(s).")
                return 0
            print("Polling Telegram. Press Ctrl+C to stop.")
            while True:
                service.poll_once(timeout=args.timeout)
                time.sleep(1)
    except KeyboardInterrupt:
        return 0
    except TelegramError as exc:
        print(str(exc), file=sys.stderr)
        return 1


def command_digest(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    try:
        with transaction(settings.database) as connection:
            _bot_service(settings, connection).send_daily_digest(
                interactive=not args.read_only
            )
        print("Daily digest sent.")
        return 0
    except TelegramError as exc:
        print(str(exc), file=sys.stderr)
        return 1


def command_export(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    output = Path(args.output)
    with transaction(settings.database) as connection:
        path = export_public_state(connection, output)
    print(f"Public dashboard data written to {path}.")
    return 0


def command_fetch_pdf(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    connection = connect(settings.database)
    try:
        try:
            document = fetch_and_extract(
                connection,
                paper_id=args.paper_id,
                storage_root=settings.database.parent,
            )
        except Exception as exc:  # The extractor stores a bounded audit error first.
            # fetch_and_extract records a compact failure status before raising.
            connection.commit()
            print(str(exc), file=sys.stderr)
            return 1
        connection.commit()
    finally:
        connection.close()
    print(
        f"Extracted paper #{document.paper_id}: {document.page_count} pages, "
        f"sha256={document.sha256}."
    )
    return 0


def command_verify_evidence(args: argparse.Namespace) -> int:
    settings = _settings()
    _ensure_db(settings)
    try:
        with transaction(settings.database) as connection:
            match = verify_and_record_evidence(
                connection,
                paper_id=args.paper_id,
                claim=args.claim,
                quote=args.quote or "",
                value_text=args.value or "",
            )
    except (KeyError, OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "status": match.status,
                "page": match.page_number,
                "context": match.context,
                "warning": "Lexical match only; verify the scientific context manually.",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if match.status != "not_found" else 1


def command_serve(args: argparse.Namespace) -> int:
    directory = (ROOT / args.directory).resolve()
    if not directory.is_dir():
        print(f"Site directory does not exist: {directory}", file=sys.stderr)
        return 2
    handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving {directory} at http://{args.host}:{args.port} (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def command_demo(args: argparse.Namespace) -> int:
    """Run the offline protocol demo; this is not a BERT experiment."""

    from pfe_hla.research import run_demo

    result = run_demo(
        args.text,
        max_queries=args.budget,
        wir_method=args.method,
    )
    print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
    print(
        "\nWARNING: lexicon mock only; do not report this as an empirical BERT result.",
        file=sys.stderr,
    )
    return 0 if result.success else 1


def _parse_id_labels(values: list[str]) -> dict[int, str | int] | None:
    if not values:
        return None
    mapping: dict[int, str | int] = {}
    for value in values:
        index_raw, separator, label_raw = value.partition("=")
        if not separator or not index_raw.strip() or not label_raw.strip():
            raise ValueError("--id-label must use INDEX=LABEL, for example 0=NEGATIVE")
        index = int(index_raw)
        label: str | int = label_raw.strip()
        if label.lstrip("-").isdigit():
            label = int(label)
        mapping[index] = label
    return mapping


def _sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def command_benchmark(args: argparse.Namespace) -> int:
    """Run a real HF label-only benchmark with an explicit lexical candidate map."""

    from pfe_hla.research import (
        AttackConstraints,
        BenchmarkConfig,
        HuggingFaceHardLabelModel,
        MappingSubstitutions,
        OptionalMLDependencyError,
        run_jsonl_benchmark,
    )

    try:
        output_path = Path(args.output)
        if output_path.exists() and not args.overwrite:
            raise ValueError(
                f"output already exists: {output_path}; choose another path or pass --overwrite"
            )
        substitutions_data = json.loads(Path(args.substitutions).read_text(encoding="utf-8"))
        if not isinstance(substitutions_data, dict):
            raise ValueError("substitution file must contain a JSON object")
        id_to_label = _parse_id_labels(args.id_label)
        model = HuggingFaceHardLabelModel.from_pretrained(
            args.model,
            local_files_only=args.local_files_only,
            id_to_label=id_to_label,
            device=args.device,
            revision=args.revision,
        )
        config = BenchmarkConfig(
            methods=tuple(args.method),
            query_budget=args.budget,
            seed=args.seed,
            constraints=AttackConstraints(
                max_changed_tokens=args.max_changed_tokens,
                max_change_ratio=args.max_change_ratio,
            ),
            mask_token=args.mask_token,
        )
        try:
            transformers_version = importlib.metadata.version("transformers")
        except importlib.metadata.PackageNotFoundError:
            transformers_version = "unknown"
        provenance = {
            "created_at": utc_now(),
            "run_name": args.run_name,
            "dataset": args.dataset or Path(args.input).stem,
            "smoke_test": "smoke" in (args.dataset or Path(args.input).stem).casefold(),
            "input_path": str(args.input),
            "input_sha256": _sha256_file(args.input),
            "substitutions_path": str(args.substitutions),
            "substitutions_sha256": _sha256_file(args.substitutions),
            "model": model.provenance,
            "python_version": platform.python_version(),
            "transformers_version": transformers_version,
            "git_commit": os.environ.get("GITHUB_SHA"),
        }
        report = run_jsonl_benchmark(
            args.input,
            args.output,
            model,
            substitutions=MappingSubstitutions(substitutions_data),
            config=config,
            valid_labels=tuple(id_to_label.values()) if id_to_label else None,
            provenance=provenance,
        )
    except (OSError, TypeError, ValueError, RuntimeError, OptionalMLDependencyError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    summary = {
        "model": model.model_name_or_path,
        "device": model.device,
        "input": args.input,
        "output": args.output,
        "eligible": report.eligible_examples,
        "total": report.total_examples,
        "aggregates": [aggregate.as_dict() for aggregate in report.aggregates],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.record:
        settings = _settings()
        _ensure_db(settings)
        with transaction(settings.database) as connection:
            for aggregate in report.aggregates:
                connection.execute(
                    """
                    INSERT INTO experiments(
                        run_name, method, dataset, model, seed, config_json,
                        metrics_json, artifact_path, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        args.run_name,
                        aggregate.method,
                        args.dataset or Path(args.input).stem,
                        model.model_name_or_path,
                        args.seed,
                        json.dumps(
                            {
                                "query_budget": args.budget,
                                "constraints": asdict(config.constraints),
                                "mask_token": args.mask_token,
                                "provenance": provenance,
                            },
                            sort_keys=True,
                        ),
                        json.dumps(aggregate.as_dict(), sort_keys=True),
                        str(args.output),
                        utc_now(),
                    ),
                )
        print("Experiment aggregates recorded in SQLite.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pfe-hla", description="Hard-label NLP research companion"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="create the SQLite database")
    init.add_argument("--seed", action="store_true", help="also add curated starter data")
    init.set_defaults(func=command_init)

    seed = sub.add_parser("seed", help="add curated papers and English vocabulary")
    seed.set_defaults(func=command_seed)

    collect = sub.add_parser("collect", help="collect metadata from scholarly APIs")
    collect.add_argument("--source", action="append", choices=("openalex", "arxiv"), default=[])
    collect.add_argument("--query", action="append", help="repeat for multiple queries")
    collect.add_argument("--limit", type=int, default=25)
    collect.add_argument(
        "--run-kind",
        choices=("pilot", "review", "watch"),
        default="pilot",
        help="only frozen 'review' runs feed PRISMA counts",
    )
    collect.set_defaults(func=command_collect)

    papers = sub.add_parser("papers", help="list papers")
    papers.add_argument("--status")
    papers.add_argument("--limit", type=int, default=50)
    papers.set_defaults(func=command_papers)

    invalidate = sub.add_parser(
        "invalidate-run", help="audit and exclude a faulty search execution"
    )
    invalidate.add_argument("run_id", type=int)
    invalidate.add_argument("--reason", required=True)
    invalidate.set_defaults(func=command_invalidate_run)

    dedupe = sub.add_parser("dedupe", help="merge exact normalized-title duplicates")
    dedupe.add_argument("--apply", action="store_true", help="apply safe merges after preview")
    dedupe.set_defaults(func=command_dedupe)

    suggestions = sub.add_parser("suggest", help="show deterministic screening suggestions")
    suggestions.add_argument("--limit", type=int, default=25)
    suggestions.add_argument("--apply-obvious-exclusions", action="store_true")
    suggestions.set_defaults(func=command_suggestions)

    screen = sub.add_parser("screen", help="record a title/abstract or full-text decision")
    screen.add_argument("paper_id", type=int)
    screen.add_argument("decision", choices=("include", "exclude", "uncertain"))
    screen.add_argument(
        "--stage", choices=("title_abstract", "full_text"), default="title_abstract"
    )
    screen.add_argument("--code")
    screen.add_argument("--reason", required=True)
    screen.add_argument("--reviewer", default="human")
    screen.set_defaults(func=command_screen)

    decide = sub.add_parser("decide", help="record final inclusion or rejection")
    decide.add_argument("paper_id", type=int)
    decide.add_argument("decision", choices=("keep", "reject", "pending"))
    decide.add_argument("--code")
    decide.add_argument("--note", default="")
    decide.set_defaults(func=command_decide)

    reopen = sub.add_parser("reopen", help="amend a decision while preserving history")
    reopen.add_argument("paper_id", type=int)
    reopen.add_argument("--to", choices=("identified", "sought", "assessed"), required=True)
    reopen.add_argument("--reason", required=True)
    reopen.add_argument("--reviewer", default="human")
    reopen.set_defaults(func=command_reopen)

    stats = sub.add_parser("stats", help="print PRISMA counts")
    stats.set_defaults(func=command_stats)

    words = sub.add_parser("words", help="show due vocabulary")
    words.add_argument("--limit", type=int, default=5)
    words.set_defaults(func=command_words)

    review = sub.add_parser("review", help="record a vocabulary review quality (0-5)")
    review.add_argument("vocabulary_id", type=int)
    review.add_argument("quality", type=int, choices=range(0, 6))
    review.set_defaults(func=command_review)

    poll = sub.add_parser("bot-poll", help="process Telegram updates")
    poll.add_argument("--watch", action="store_true")
    poll.add_argument("--timeout", type=int, default=20)
    poll.set_defaults(func=command_bot_poll)

    digest = sub.add_parser("digest", help="send today's Telegram digest")
    digest.add_argument(
        "--read-only",
        action="store_true",
        help="send no callback buttons (required when the sender has no durable shared DB)",
    )
    digest.set_defaults(func=command_digest)

    export = sub.add_parser("export", help="write dashboard JSON")
    export.add_argument("--output", default="site/data/state.json")
    export.set_defaults(func=command_export)

    sync = sub.add_parser("sync-decisions", help="pull screening decisions from Telegram bot")
    sync.set_defaults(func=lambda args: __import__('pfe_hla.sync_decisions', fromlist=['']).run_sync_decisions())

    fetch_pdf = sub.add_parser("fetch-pdf", help="download and extract one recorded PDF")
    fetch_pdf.add_argument("paper_id", type=int)
    fetch_pdf.set_defaults(func=command_fetch_pdf)

    evidence = sub.add_parser("verify-evidence", help="lexically verify a quote or value")
    evidence.add_argument("paper_id", type=int)
    evidence.add_argument("--claim", required=True)
    evidence.add_argument("--quote")
    evidence.add_argument("--value")
    evidence.set_defaults(func=command_verify_evidence)

    serve = sub.add_parser("serve", help="serve the static dashboard locally")
    serve.add_argument("--directory", default="site")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.set_defaults(func=command_serve)

    demo = sub.add_parser("demo", help="run a zero-dependency hard-label WIR demonstration")
    demo.add_argument("--text", default="the model is good and robust")
    demo.add_argument(
        "--method",
        choices=("deletion", "masking", "neighborhood"),
        default="neighborhood",
    )
    demo.add_argument("--budget", type=positive_int, default=100)
    demo.set_defaults(func=command_demo)

    benchmark = sub.add_parser(
        "benchmark", help="run a Hugging Face hard-label benchmark from JSONL"
    )
    benchmark.add_argument("--input", default="data/smoke_sentiment.jsonl")
    benchmark.add_argument("--output", default="artifacts/benchmark.jsonl")
    benchmark.add_argument(
        "--substitutions", default="data/smoke_substitutions.json"
    )
    benchmark.add_argument(
        "--model", default="distilbert-base-uncased-finetuned-sst-2-english"
    )
    benchmark.add_argument(
        "--revision",
        help="immutable Hugging Face revision/commit; strongly recommended for final runs",
    )
    benchmark.add_argument(
        "--method",
        action="append",
        choices=("deletion", "masking", "neighborhood"),
        default=[],
        help="repeat to select methods; defaults to all three",
    )
    benchmark.add_argument("--budget", type=positive_int, default=500)
    benchmark.add_argument("--seed", type=int, default=42)
    benchmark.add_argument("--max-change-ratio", type=float, default=0.2)
    benchmark.add_argument("--max-changed-tokens", type=int)
    benchmark.add_argument("--mask-token", default="[MASK]")
    benchmark.add_argument("--device")
    benchmark.add_argument("--local-files-only", action="store_true")
    benchmark.add_argument(
        "--id-label",
        action="append",
        default=[],
        help="override a class mapping, e.g. 0=NEGATIVE",
    )
    benchmark.add_argument("--record", action="store_true")
    benchmark.add_argument(
        "--overwrite",
        action="store_true",
        help="explicitly replace an existing JSONL artifact",
    )
    benchmark.add_argument("--run-name", default="hf-smoke")
    benchmark.add_argument("--dataset")
    benchmark.set_defaults(func=command_benchmark)
    return parser


def main(argv: list[str] | None = None) -> int:
    # Windows PowerShell 5 may expose a legacy cp1252 console even when project
    # files are UTF-8. Reconfigure streams so French text and Telegram-style
    # vocabulary cards remain printable.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    if args.command == "collect" and not args.source:
        args.source = ["openalex", "arxiv"]
    if args.command == "benchmark" and not args.method:
        args.method = ["deletion", "masking", "neighborhood"]
    return int(args.func(args))
