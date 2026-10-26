"""AI research agents orchestrated from Python.

Three agents run inside the scheduled GitHub Actions pipeline:

* **Trieur** — pre-screens titles/abstracts against I1–I5/E1–E8 (suggestions only);
* **Lecteur** — reads an extracted full text and writes a structured reading sheet;
* **Synthèse** — compares the sheets and drafts state-of-the-art material.

Two interchangeable backends implement the same ``Runner`` protocol:

* ``GeminiRunner`` (default) — Google Gemini API on the user's free key; the
  input files are sent inline and the answer is constrained by a JSON schema;
* ``ClaudeCodeRunner`` (optional) — ``claude -p`` with read-only tools, for a
  Claude subscription token.

Every answer must match a schema in ``agents/schemas``. Quotes and values are
then checked lexically against the PDF text, so the site can show which claims
were found verbatim. Nothing here records a human screening decision.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from string import Template
from typing import Any, Protocol

from pfe_hla.fulltext import load_extracted_pages, verify_evidence_in_pages
from pfe_hla.library import paper_key, utc_now
from pfe_hla.reading import extracted_text_path, mark_read, pending_reading
from pfe_hla.screening import TITLE_ABSTRACT_EXCLUSION_CODES

AGENTS_DIR = Path(__file__).resolve().parents[2] / "agents"
PROMPT_VERSIONS = {
    "screening": "screening-v1",
    "reading": "sheet-v1",
    "synthesis": "synthesis-v1",
}
ACCESS_REGIMES = {"hard-label", "score-based", "white-box", "mixed", "not-applicable", "unknown"}
CONTRIBUTION_TYPES = {"attack", "defense", "benchmark", "survey", "analysis", "other"}
MAX_ABSTRACT_CHARS = 2500
MAX_VOCABULARY_PER_SHEET = 5


class AgentError(RuntimeError):
    """An agent call failed or returned unusable output."""


@dataclass(slots=True)
class AgentResult:
    output: dict[str, Any]
    model: str = ""
    cost_usd: float | None = None
    duration_ms: int = 0
    turns: int = 0
    note: str = ""


class Runner(Protocol):
    def run(
        self, *, prompt: str, schema: dict[str, Any], cwd: Path, max_turns: int, timeout: int
    ) -> AgentResult: ...


def load_schema(name: str) -> dict[str, Any]:
    return json.loads((AGENTS_DIR / "schemas" / f"{name}.schema.json").read_text(encoding="utf-8"))


def load_prompt(name: str, **values: Any) -> str:
    template = Template((AGENTS_DIR / "prompts" / f"{name}.md").read_text(encoding="utf-8"))
    return template.substitute({key: str(value) for key, value in values.items()})


def credentials_available(env: dict[str, str] | None = None) -> bool:
    return select_backend(env) is not None


def select_backend(env: dict[str, str] | None = None) -> str | None:
    """Pick the agent backend: the free Gemini key first, Claude only if configured."""

    env = os.environ if env is None else env
    has_gemini = bool(env.get("GEMINI_API_KEY"))
    has_claude = bool(env.get("CLAUDE_CODE_OAUTH_TOKEN") or env.get("ANTHROPIC_API_KEY"))
    choice = (env.get("AGENT_BACKEND") or "auto").strip().lower()
    if choice == "gemini":
        return "gemini" if has_gemini else None
    if choice == "claude":
        return "claude" if has_claude else None
    if has_gemini:
        return "gemini"
    return "claude" if has_claude else None


# Newest models first; overloaded (503) or retired (404) models are skipped.
DEFAULT_GEMINI_MODELS = (
    "gemini-3.8-flash",
    "gemini-flash-latest",
    "gemini-3.5-flash",
    "gemini-flash-lite-latest",
    "gemini-3.1-flash-lite",
)
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})


@dataclass(slots=True)
class GeminiRunner:
    """Gemini ``generateContent`` with a JSON-schema-constrained answer.

    The task directory's files are sent inline (Gemini Flash reads ~1M tokens),
    so the same prompts work without file tools. Busy or rate-limited models are
    retried with backoff, then the next model of the chain is tried.
    """

    api_key: str
    models: tuple[str, ...] = DEFAULT_GEMINI_MODELS
    system_prompt_file: Path = AGENTS_DIR / "prompts" / "system.md"
    attempts_per_model: int = 2
    backoff_seconds: float = 20.0
    request_timeout: int = 240  # a stuck overloaded model must not freeze the pipeline
    max_input_chars: int = 1_200_000
    sleep: Callable[[float], None] = time.sleep
    opener: Callable[..., Any] = urllib.request.urlopen

    def _inputs(self, cwd: Path) -> str:
        parts = []
        for path in sorted(cwd.iterdir()):
            if path.is_file():
                content = path.read_text(encoding="utf-8", errors="replace")
                parts.append(
                    f"<<<FICHIER {path.name}>>>\n{content}\n<<<FIN DU FICHIER {path.name}>>>"
                )
        text = "\n\n".join(parts)
        if len(text) > self.max_input_chars:
            # Never truncate silently: a partial paper would yield a misleading sheet.
            raise AgentError(
                f"input of {len(text)} characters exceeds the {self.max_input_chars} limit"
            )
        return text

    def _post(self, model: str, body: dict[str, Any], timeout: int) -> dict[str, Any]:
        request = urllib.request.Request(
            GEMINI_ENDPOINT.format(model=model),
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": self.api_key,
                "User-Agent": "PFE-HLA/0.2 agents",
            },
        )
        with self.opener(request, timeout=timeout) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8"))

    def run(
        self, *, prompt: str, schema: dict[str, Any], cwd: Path, max_turns: int, timeout: int
    ) -> AgentResult:
        del max_turns  # one request per task: the whole input is sent inline
        system = self.system_prompt_file.read_text(encoding="utf-8")
        user_text = (
            f"{prompt}\n\n# Fichiers fournis\n\n{self._inputs(cwd)}\n\n"
            "Réponds uniquement avec l'objet JSON demandé."
        )
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user_text}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseJsonSchema": schema,
                "temperature": 0.2,
                "maxOutputTokens": 32768,
            },
        }
        started = time.monotonic()
        failures: list[str] = []
        for model in self.models:
            for attempt in range(self.attempts_per_model):
                try:
                    payload = self._post(model, body, min(timeout, self.request_timeout))
                except urllib.error.HTTPError as exc:
                    detail = exc.read().decode("utf-8", "replace")[:200] if exc.fp else ""
                    failures.append(f"{model}: HTTP {exc.code}")
                    if exc.code in RETRYABLE_STATUS:
                        self.sleep(self.backoff_seconds * (attempt + 1))
                        continue
                    if exc.code in {400, 401, 403} and "API key" in detail:
                        raise AgentError(f"Gemini rejected the API key: {detail}") from exc
                    break  # 404 retired model, 400 unsupported feature: next model
                except (urllib.error.URLError, TimeoutError, OSError) as exc:
                    failures.append(f"{model}: {type(exc).__name__}")
                    self.sleep(self.backoff_seconds * (attempt + 1))
                    continue
                candidate = (payload.get("candidates") or [{}])[0]
                text = "".join(
                    part.get("text", "")
                    for part in (candidate.get("content") or {}).get("parts", [])
                    if not part.get("thought")
                )
                try:
                    output = json.loads(text)
                except json.JSONDecodeError:
                    failures.append(f"{model}: invalid JSON ({candidate.get('finishReason')})")
                    continue
                if not isinstance(output, dict):
                    failures.append(f"{model}: JSON is not an object")
                    continue
                usage = payload.get("usageMetadata") or {}
                return AgentResult(
                    output=output,
                    model=str(payload.get("modelVersion") or model),
                    cost_usd=None,
                    duration_ms=int((time.monotonic() - started) * 1000),
                    turns=1,
                    note=(
                        f"tokens {usage.get('promptTokenCount', '?')}→"
                        f"{usage.get('candidatesTokenCount', '?')}"
                    ),
                )
        raise AgentError("all Gemini models failed: " + "; ".join(failures[-6:]))


def build_runner(
    env: dict[str, str] | None = None,
    *,
    model: str = "",
    claude_bin: str = "claude",
) -> Runner | None:
    env = os.environ if env is None else env
    backend = select_backend(env)
    if backend == "gemini":
        models = tuple(item.strip() for item in model.split(",") if item.strip())
        return GeminiRunner(api_key=env["GEMINI_API_KEY"], models=models or DEFAULT_GEMINI_MODELS)
    if backend == "claude":
        return ClaudeCodeRunner(binary=claude_bin, model=model or None)
    return None


@dataclass(slots=True)
class ClaudeCodeRunner:
    """Run ``claude -p`` with read-only tools and a JSON-schema-validated result."""

    binary: str = "claude"
    model: str | None = None
    system_prompt_file: Path = AGENTS_DIR / "prompts" / "system.md"
    tools: tuple[str, ...] = ("Read", "Grep", "Glob")

    def command(self, *, prompt: str, schema: dict[str, Any], max_turns: int) -> list[str]:
        tools = ",".join(self.tools)
        command = [
            self.binary,
            "-p",
            prompt,
            "--output-format",
            "json",
            "--json-schema",
            json.dumps(schema, separators=(",", ":")),
            "--tools",
            tools,
            "--allowedTools",
            tools,
            "--permission-mode",
            "dontAsk",
            "--max-turns",
            str(max_turns),
            "--no-session-persistence",
            "--append-system-prompt-file",
            str(self.system_prompt_file),
        ]
        if self.model:
            command += ["--model", self.model]
        return command

    def run(
        self, *, prompt: str, schema: dict[str, Any], cwd: Path, max_turns: int, timeout: int
    ) -> AgentResult:
        binary = shutil.which(self.binary) or self.binary
        command = self.command(prompt=prompt, schema=schema, max_turns=max_turns)
        command[0] = binary
        started = time.monotonic()
        try:
            completed = subprocess.run(  # noqa: S603
                command,
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
        except FileNotFoundError as exc:
            raise AgentError("Claude Code CLI is not installed") from exc
        except subprocess.TimeoutExpired as exc:
            raise AgentError(f"agent timed out after {timeout}s") from exc
        duration_ms = int((time.monotonic() - started) * 1000)
        payload = parse_cli_output(completed.stdout)
        if completed.returncode != 0 or payload.get("is_error"):
            reason = payload.get("result") or payload.get("subtype") or completed.stderr
            raise AgentError(f"claude exited {completed.returncode}: {str(reason)[:300]}")
        structured = payload.get("structured_output")
        if not isinstance(structured, dict):
            raise AgentError("the agent returned no structured_output")
        model_usage = payload.get("modelUsage") or {}
        model = next(iter(model_usage), "") if isinstance(model_usage, dict) else ""
        cost = payload.get("total_cost_usd")
        return AgentResult(
            output=structured,
            model=model or (self.model or "claude-code-default"),
            cost_usd=float(cost) if isinstance(cost, int | float) else None,
            duration_ms=duration_ms,
            turns=int(payload.get("num_turns") or 0),
        )


def parse_cli_output(stdout: str) -> dict[str, Any]:
    text = (stdout or "").strip()
    if not text:
        return {}
    for candidate in (text, text.splitlines()[-1]):
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return {"result": text[:300], "is_error": True}


@dataclass(slots=True)
class AgentPlan:
    max_screen: int = 50
    batch_size: int = 25
    max_read: int = 3
    synthesis: bool = True
    screen_turns: int = 8
    read_turns: int = 30
    synthesis_turns: int = 15
    timeout: int = 1200


@dataclass(slots=True)
class AgentSummary:
    screened: int = 0
    sheets: int = 0
    synthesis: bool = False
    errors: list[str] = field(default_factory=list)
    skipped: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "screened": self.screened,
            "sheets": self.sheets,
            "synthesis": self.synthesis,
            "errors": self.errors,
            "skipped": self.skipped,
        }


def log_agent_run(
    connection: sqlite3.Connection,
    *,
    task: str,
    target: str,
    status: str,
    started_at: str,
    result: AgentResult | None = None,
    detail: str = "",
) -> None:
    if result is not None and result.note:
        detail = f"{detail} · {result.note}" if detail else result.note
    connection.execute(
        """
        INSERT INTO agent_runs(
            task, target, status, model, duration_ms, cost_usd, detail, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task,
            target,
            status,
            result.model if result else "",
            result.duration_ms if result else 0,
            result.cost_usd if result else None,
            detail[:500],
            started_at,
        ),
    )


# ─── Trieur : title/abstract pre-screening ───────────────────────────────────


def screening_candidates(connection: sqlite3.Connection, *, limit: int) -> list[sqlite3.Row]:
    """Unscreened papers, formal corpus first, then the most recently discovered."""

    return list(
        connection.execute(
            """
            SELECT papers.*,
                   EXISTS (
                       SELECT 1 FROM paper_hits
                       JOIN search_runs ON search_runs.id=paper_hits.run_id
                       JOIN search_run_details ON search_run_details.run_id=search_runs.id
                       WHERE paper_hits.paper_id=papers.id AND search_runs.status='ok'
                         AND search_run_details.run_kind='review'
                   ) AS formal
            FROM papers
            WHERE papers.status IN ('identified', 'screened')
              AND NOT EXISTS (
                  SELECT 1 FROM ai_screening
                  WHERE ai_screening.paper_id=papers.id AND ai_screening.prompt_version=?
              )
            ORDER BY formal DESC, papers.discovered_at DESC, papers.id DESC
            LIMIT ?
            """,
            (PROMPT_VERSIONS["screening"], limit),
        )
    )


def _screening_record(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "key": paper_key(str(row["canonical_key"])),
        "title": row["title"],
        "abstract": (row["abstract"] or "")[:MAX_ABSTRACT_CHARS] or "(résumé absent)",
        "year": row["publication_year"],
        "venue": row["venue"] or row["source"],
        "language": row["language"],
    }


def ingest_screening(
    connection: sqlite3.Connection,
    rows: list[sqlite3.Row],
    output: dict[str, Any],
    *,
    model: str,
) -> int:
    by_key = {paper_key(str(row["canonical_key"])): int(row["id"]) for row in rows}
    inserted = 0
    timestamp = utc_now()
    for item in output.get("suggestions", []):
        paper_id = by_key.get(str(item.get("key", "")))
        decision = item.get("decision")
        if paper_id is None or decision not in {"include", "exclude", "uncertain"}:
            continue
        code = item.get("reason_code") if decision == "exclude" else None
        if decision == "exclude" and code not in TITLE_ABSTRACT_EXCLUSION_CODES:
            decision, code = "uncertain", None
        access = item.get("access_regime")
        contribution = item.get("contribution_type")
        connection.execute(
            """
            INSERT INTO ai_screening(
                paper_id, decision, reason_code, access_regime, contribution_type,
                relevance, confidence, rationale, model, prompt_version, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                paper_id,
                decision,
                code,
                access if access in ACCESS_REGIMES else "unknown",
                contribution if contribution in CONTRIBUTION_TYPES else "other",
                min(max(int(item.get("relevance") or 0), 0), 5),
                min(max(float(item.get("confidence") or 0), 0.0), 1.0),
                str(item.get("rationale") or "").strip()[:600] or "Sans justification.",
                model,
                PROMPT_VERSIONS["screening"],
                timestamp,
            ),
        )
        inserted += 1
        by_key.pop(str(item.get("key")), None)
    return inserted


def run_screening(
    connection: sqlite3.Connection, runner: Runner, workdir: Path, plan: AgentPlan
) -> tuple[int, list[str]]:
    candidates = screening_candidates(connection, limit=plan.max_screen)
    screened, errors = 0, []
    schema = load_schema("screening")
    for index in range(0, len(candidates), plan.batch_size):
        batch = candidates[index : index + plan.batch_size]
        name = f"batch-{index // plan.batch_size + 1:02d}.json"
        batch_dir = workdir / "screening"
        batch_dir.mkdir(parents=True, exist_ok=True)
        (batch_dir / name).write_text(
            json.dumps([_screening_record(row) for row in batch], ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        started = utc_now()
        try:
            result = runner.run(
                prompt=load_prompt("screening", batch_file=name),
                schema=schema,
                cwd=batch_dir,
                max_turns=plan.screen_turns,
                timeout=plan.timeout,
            )
            count = ingest_screening(connection, batch, result.output, model=result.model)
            log_agent_run(
                connection, task="screening", target=name, status="ok",
                started_at=started, result=result, detail=f"{count}/{len(batch)} suggestions",
            )
            screened += count
        except AgentError as exc:
            errors.append(f"screening {name}: {exc}")
            log_agent_run(
                connection, task="screening", target=name, status="error",
                started_at=started, detail=str(exc),
            )
        connection.commit()
    return screened, errors


# ─── Lecteur : full-text reading sheets ──────────────────────────────────────


def verify_sheet(sheet: dict[str, Any], pages: list[str]) -> dict[str, Any]:
    """Lexically locate every quote/value of a sheet in the extracted pages."""

    checks: list[dict[str, Any]] = []

    def check(field_name: str, quote: str, value: str = "") -> None:
        quote, value = (quote or "").strip(), (value or "").strip()
        if not quote and not value:
            return
        match = verify_evidence_in_pages(pages, quote=quote, value_text=value)
        checks.append({"field": field_name, "status": match.status, "page": match.page_number})

    check("acces_oracle", str((sheet.get("acces_oracle") or {}).get("citation", "")))
    for index, item in enumerate(sheet.get("resultats") or []):
        check(f"resultats[{index}]", str(item.get("citation", "")), str(item.get("valeur", "")))
    for index, item in enumerate(sheet.get("vocabulaire") or []):
        check(f"vocabulaire[{index}]", str(item.get("exemple_en", "")))
    summary = Counter(item["status"] for item in checks)
    return {
        "citations": checks,
        "summary": {
            "exact_quote": summary.get("exact_quote", 0),
            "value_only": summary.get("value_only", 0),
            "not_found": summary.get("not_found", 0),
        },
    }


def ingest_sheet(
    connection: sqlite3.Connection,
    *,
    paper_id: int,
    sheet: dict[str, Any],
    pages: list[str],
    document_sha256: str,
    model: str,
) -> dict[str, Any]:
    checks = verify_sheet(sheet, pages)
    timestamp = utc_now()
    connection.execute(
        """
        INSERT INTO paper_sheets(
            paper_id, sheet_json, source_kind, document_sha256, checks_json,
            model, prompt_version, created_at, updated_at
        ) VALUES (?, ?, 'full_text', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(paper_id) DO UPDATE SET
            sheet_json=excluded.sheet_json,
            document_sha256=excluded.document_sha256,
            checks_json=excluded.checks_json,
            model=excluded.model,
            prompt_version=excluded.prompt_version,
            updated_at=excluded.updated_at
        """,
        (
            paper_id,
            json.dumps(sheet, ensure_ascii=False),
            document_sha256,
            json.dumps(checks, ensure_ascii=False),
            model,
            PROMPT_VERSIONS["reading"],
            timestamp,
            timestamp,
        ),
    )
    for item in (sheet.get("vocabulaire") or [])[:MAX_VOCABULARY_PER_SHEET]:
        term = str(item.get("terme", "")).strip()
        if not term or len(term) > 80:
            continue
        connection.execute(
            """
            INSERT OR IGNORE INTO vocabulary(
                term, translation_fr, definition_en, synonyms_json, example_en,
                source_paper_id, due_at, created_at
            ) VALUES (?, ?, ?, '[]', ?, ?, ?, ?)
            """,
            (
                term,
                str(item.get("traduction_fr", "")).strip() or "—",
                str(item.get("definition_en", "")).strip() or "—",
                str(item.get("exemple_en", "")).strip() or "—",
                paper_id,
                timestamp,
                timestamp,
            ),
        )
    return checks


def run_reading(
    connection: sqlite3.Connection, runner: Runner, workdir: Path, plan: AgentPlan
) -> tuple[int, list[str]]:
    written, errors = 0, []
    schema = load_schema("sheet")
    for paper in pending_reading(connection, limit=plan.max_read):
        paper_id = int(paper["id"])
        text_path = extracted_text_path(connection, paper_id)
        if text_path is None:
            continue
        key = paper_key(str(paper["canonical_key"]))
        paper_dir = workdir / "reading" / key
        paper_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(text_path, paper_dir / "fulltext.txt")
        document = connection.execute(
            "SELECT sha256 FROM paper_documents WHERE paper_id=?", (paper_id,)
        ).fetchone()
        started = utc_now()
        try:
            result = runner.run(
                prompt=load_prompt(
                    "reading",
                    title=paper["title"],
                    year=paper["publication_year"] or "année inconnue",
                    venue=paper["venue"] or paper["source"],
                    text_file="fulltext.txt",
                ),
                schema=schema,
                cwd=paper_dir,
                max_turns=plan.read_turns,
                timeout=plan.timeout,
            )
            checks = ingest_sheet(
                connection,
                paper_id=paper_id,
                sheet=result.output,
                pages=load_extracted_pages(text_path),
                document_sha256=document["sha256"] if document else "",
                model=result.model,
            )
            mark_read(connection, paper_id)
            summary = checks["summary"]
            log_agent_run(
                connection, task="reading", target=key, status="ok", started_at=started,
                result=result,
                detail=(
                    f"citations: {summary['exact_quote']} exactes, "
                    f"{summary['value_only']} valeur seule, {summary['not_found']} introuvables"
                ),
            )
            written += 1
        except (AgentError, OSError, ValueError) as exc:
            errors.append(f"reading {key}: {exc}")
            connection.execute(
                """
                UPDATE reading_queue SET attempts=attempts+1, last_error=? WHERE paper_id=?
                """,
                (str(exc)[:300], paper_id),
            )
            log_agent_run(
                connection, task="reading", target=key, status="error",
                started_at=started, detail=str(exc),
            )
        connection.commit()
    return written, errors


# ─── Synthèse : comparison and state-of-the-art drafts ──────────────────────


def synthesis_needed(connection: sqlite3.Connection) -> bool:
    row = connection.execute(
        """
        SELECT COUNT(*) AS n, MAX(updated_at) AS latest_sheet,
               (SELECT MAX(created_at) FROM synthesis) AS latest_synthesis
        FROM paper_sheets
        """
    ).fetchone()
    if int(row["n"]) < 2:
        return False
    return row["latest_synthesis"] is None or row["latest_sheet"] > row["latest_synthesis"]


def sheets_for_synthesis(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    sheets = []
    for row in connection.execute(
        """
        SELECT papers.id, papers.canonical_key, papers.title, papers.authors_json,
               papers.publication_year, paper_sheets.sheet_json, paper_sheets.checks_json
        FROM paper_sheets JOIN papers ON papers.id = paper_sheets.paper_id
        ORDER BY papers.publication_year, papers.title
        """
    ):
        authors = json.loads(row["authors_json"] or "[]")
        sheets.append(
            {
                "key": paper_key(str(row["canonical_key"])),
                "paper_id": int(row["id"]),
                "title": row["title"],
                "authors": authors[:4],
                "year": row["publication_year"],
                "sheet": json.loads(row["sheet_json"]),
                "checks": json.loads(row["checks_json"] or "{}").get("summary", {}),
            }
        )
    return sheets


def run_synthesis(
    connection: sqlite3.Connection, runner: Runner, workdir: Path, plan: AgentPlan
) -> tuple[bool, list[str]]:
    if not synthesis_needed(connection):
        return False, []
    sheets = sheets_for_synthesis(connection)
    synthesis_dir = workdir / "synthesis"
    synthesis_dir.mkdir(parents=True, exist_ok=True)
    payload = [{key: value for key, value in item.items() if key != "paper_id"} for item in sheets]
    (synthesis_dir / "sheets.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    started = utc_now()
    try:
        result = runner.run(
            prompt=load_prompt("synthesis", sheets_file="sheets.json"),
            schema=load_schema("synthesis"),
            cwd=synthesis_dir,
            max_turns=plan.synthesis_turns,
            timeout=plan.timeout,
        )
    except AgentError as exc:
        log_agent_run(
            connection, task="synthesis", target=f"{len(sheets)} fiches", status="error",
            started_at=started, detail=str(exc),
        )
        connection.commit()
        return False, [f"synthesis: {exc}"]
    connection.execute(
        """
        INSERT INTO synthesis(content_json, paper_ids_json, model, prompt_version, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            json.dumps(result.output, ensure_ascii=False),
            json.dumps([item["paper_id"] for item in sheets]),
            result.model,
            PROMPT_VERSIONS["synthesis"],
            utc_now(),
        ),
    )
    log_agent_run(
        connection, task="synthesis", target=f"{len(sheets)} fiches", status="ok",
        started_at=started, result=result,
    )
    connection.commit()
    return True, []


def run_agents(
    connection: sqlite3.Connection,
    runner: Runner,
    *,
    workdir: Path,
    plan: AgentPlan,
) -> AgentSummary:
    """Run Trieur, Lecteur and Synthèse in order, committing after every task."""

    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)
    summary = AgentSummary()
    if plan.max_screen > 0:
        summary.screened, errors = run_screening(connection, runner, workdir, plan)
        summary.errors.extend(errors)
    if plan.max_read > 0:
        summary.sheets, errors = run_reading(connection, runner, workdir, plan)
        summary.errors.extend(errors)
    if plan.synthesis:
        summary.synthesis, errors = run_synthesis(connection, runner, workdir, plan)
        summary.errors.extend(errors)
    return summary


def record_skip(connection: sqlite3.Connection, reason: str) -> None:
    log_agent_run(
        connection, task="pipeline", target="", status="skipped",
        started_at=utc_now(), detail=reason,
    )
    connection.commit()
