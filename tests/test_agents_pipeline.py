from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from typing import Any

from pfe_hla.agents import (
    AgentError,
    AgentPlan,
    AgentResult,
    ClaudeCodeRunner,
    credentials_available,
    parse_cli_output,
    run_agents,
    synthesis_needed,
)
from pfe_hla.db import SCHEMA_VERSION, connect, init_database
from pfe_hla.export import build_bot_state, build_public_state, build_sheets_state
from pfe_hla.fulltext import PAGE_MARKER
from pfe_hla.library import paper_key, paper_key_index, seed_library
from pfe_hla.protocol import active_protocol, freeze_protocol
from pfe_hla.reading import resolve_pdf_url
from pfe_hla.sync import apply_events, carry_triage_into_review, queue_for_reading

ROOT = Path(__file__).resolve().parents[1]

FULL_TEXT = (
    PAGE_MARKER.format(number=1)
    + "\nWe study a hard-label setting where the attacker only observes the top label.\n"
    + "Our attack reaches an attack success rate of 88.4% on SST-2.\n\n"
    + PAGE_MARKER.format(number=2)
    + "\nThe query budget is fixed to 500 queries per example.\n"
)


def sheet_output(*, citation: str = "the attacker only observes the top label") -> dict:
    return {
        "resume_simple": "Résumé simple.",
        "probleme": "Problème.",
        "contributions": ["Une attaque hard-label."],
        "methode": "Méthode.",
        "acces_oracle": {
            "regime": "hard-label",
            "justification": "Seule la classe est observée.",
            "citation": citation,
        },
        "composants": {
            "wir": "non précisé dans le texte",
            "candidats": "synonymes",
            "filtres": "similarité",
            "recherche": "gloutonne",
            "budget_requetes": "500",
        },
        "evaluation": {
            "datasets": ["SST-2"],
            "modeles_cibles": ["BERT"],
            "metriques": ["ASR"],
            "baselines": [],
        },
        "resultats": [
            {
                "affirmation": "ASR sur SST-2",
                "valeur": "88.4%",
                "citation": "attack success rate of 88.4% on SST-2",
            },
            {"affirmation": "Inventé", "valeur": "99.9%", "citation": "never written anywhere"},
        ],
        "points_forts": ["Clair."],
        "faiblesses": ["Un seul dataset."],
        "menaces_validite": ["Budget non comparable."],
        "reproductibilite": {"code_disponible": None, "lien_code": "", "commentaire": ""},
        "limites_auteurs": [],
        "qualite": {
            "menace_definie": 1,
            "budget_complet": 1,
            "baselines_comparables": 0,
            "contraintes_operationnalisees": 0,
            "echantillon_decrit": 0,
            "variance_ou_ic": 0,
            "reproductible": 0,
            "limites_rapportees": 0,
        },
        "eligibilite": {"suggestion": "include", "code_exclusion": None, "justification": "I1-I5"},
        "pertinence_pfe": {"score": 5, "questions": ["RQ1"], "pourquoi": "Cœur du sujet."},
        "pistes_contribution": ["Tester un WIR par vote."],
        "phrase_etat_de_lart": "Auteur et al. (2021) proposent…",
        "vocabulaire": [
            {
                "terme": "query budget",
                "traduction_fr": "budget de requêtes",
                "definition_en": "Max number of calls.",
                "exemple_en": "The query budget is fixed to 500 queries per example.",
            },
            {
                "terme": "top label",
                "traduction_fr": "classe prédite",
                "definition_en": "The predicted class.",
                "exemple_en": "the attacker only observes the top label",
            },
        ],
    }


class FakeRunner:
    """Stands in for `claude -p`: answers each task from the prompt contents."""

    def __init__(self, *, fail_reading: bool = False) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail_reading = fail_reading

    def run(self, *, prompt: str, schema: dict, cwd: Path, max_turns: int, timeout: int):
        self.calls.append({"prompt": prompt, "cwd": cwd, "max_turns": max_turns})
        if "pré-tri" in prompt:
            batch_name = next(word.strip("`") for word in prompt.split() if "batch-" in word)
            records = json.loads((cwd / batch_name).read_text(encoding="utf-8"))
            suggestions = []
            for index, record in enumerate(records):
                if index == 0:
                    item = {"decision": "include", "reason_code": None, "relevance": 5}
                elif index == 1:
                    # invalid exclusion code for title/abstract: must become "uncertain"
                    item = {"decision": "exclude", "reason_code": "E6", "relevance": 0}
                else:
                    item = {"decision": "exclude", "reason_code": "E2", "relevance": 1}
                suggestions.append(
                    {
                        "key": record["key"],
                        "access_regime": "hard-label",
                        "contribution_type": "attack",
                        "confidence": 0.9,
                        "rationale": "I2 : test.",
                        **item,
                    }
                )
            suggestions.append({"key": "not-in-batch", "decision": "include"})
            return AgentResult({"suggestions": suggestions}, model="fake-model")
        if "fiche de lecture" in prompt:
            if self.fail_reading:
                raise AgentError("simulated failure")
            assert (cwd / "fulltext.txt").exists()
            return AgentResult(sheet_output(), model="fake-model", cost_usd=0.01)
        if "titres et résumés" in prompt:
            batch_name = next(
                word.strip("`") for word in prompt.split() if word.strip("`").endswith(".json")
            )
            records = json.loads((cwd / batch_name).read_text(encoding="utf-8"))
            items = [
                {
                    "key": record["key"],
                    "titre_fr": f"FR {record['title']}",
                    "resume_fr": f"FR {record['abstract']}",
                }
                for record in records
            ]
            return AgentResult({"items": items}, model="fake-lite")
        if "synthèse" in prompt:
            sheets = json.loads((cwd / "sheets.json").read_text(encoding="utf-8"))
            return AgentResult(
                {
                    "vue_ensemble": "Vue.",
                    "comparatif": [
                        {
                            "key": item["key"], "acces": "hard-label", "wir": "-",
                            "candidats": "-", "recherche": "-", "datasets": "SST-2",
                            "modeles": "BERT", "budget": "500",
                            "resultat_principal": "88.4%", "comparabilite": "-",
                        }
                        for item in sheets
                    ],
                    "etat_de_lart": [{"titre": "T", "paragraphe": "P", "cles": []}],
                    "incoherences": [],
                    "lacunes_pistes": [],
                    "prochaines_etapes": ["Lire"],
                },
                model="fake-model",
            )
        raise AssertionError(f"unexpected prompt: {prompt[:80]}")


class PipelineTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.db_path = self.root / "test.db"
        init_database(self.db_path)
        self.connection = connect(self.db_path)
        seed_library(
            self.connection, ROOT / "data/seed_papers.json", ROOT / "data/seed_vocabulary.json"
        )
        self.connection.commit()
        self.paper_ids = [
            int(row["id"]) for row in self.connection.execute("SELECT id FROM papers ORDER BY id")
        ]

    def tearDown(self) -> None:
        self.connection.close()
        self.temp_dir.cleanup()

    def key_of(self, paper_id: int) -> str:
        row = self.connection.execute(
            "SELECT canonical_key FROM papers WHERE id=?", (paper_id,)
        ).fetchone()
        return paper_key(str(row["canonical_key"]))

    def add_review_hits(self, paper_ids: list[int]) -> None:
        cursor = self.connection.execute(
            """
            INSERT INTO search_runs(source, query, started_at, finished_at, returned_count,
                                    inserted_count, status)
            VALUES ('OpenAlex', 'formal', '2026-01-01', '2026-01-01', ?, 0, 'ok')
            """,
            (len(paper_ids),),
        )
        run_id = int(cursor.lastrowid)
        self.connection.execute(
            """
            INSERT INTO search_run_details(run_id, executed_query, request_url, run_kind,
                                           protocol_version)
            VALUES (?, 'formal', 'https://example.invalid/q', 'review', 'v1')
            """,
            (run_id,),
        )
        self.connection.executemany(
            "INSERT INTO paper_hits(run_id, paper_id, source_rank) VALUES (?, ?, ?)",
            [(run_id, paper_id, rank) for rank, paper_id in enumerate(paper_ids, start=1)],
        )

    def add_document(self, paper_id: int) -> Path:
        text_path = self.root / f"paper-{paper_id}.txt"
        text_path.write_text(FULL_TEXT, encoding="utf-8")
        self.connection.execute(
            """
            INSERT INTO paper_documents(paper_id, pdf_path, text_path, sha256, page_count,
                                        character_count, extraction_status, extracted_at)
            VALUES (?, 'x.pdf', ?, 'abc123', 2, ?, 'extracted', '2026-01-01')
            """,
            (paper_id, str(text_path), len(FULL_TEXT)),
        )
        return text_path


class MigrationTests(unittest.TestCase):
    def test_v1_database_gains_v2_tables_and_column(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "old.db"
            raw = sqlite3.connect(path)
            raw.executescript(
                """
                CREATE TABLE schema_meta (version INTEGER NOT NULL);
                INSERT INTO schema_meta(version) VALUES (1);
                CREATE TABLE search_runs (id INTEGER PRIMARY KEY, source TEXT NOT NULL,
                    query TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
                    returned_count INTEGER NOT NULL DEFAULT 0,
                    inserted_count INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'running', error TEXT NOT NULL DEFAULT '');
                CREATE TABLE search_run_details (run_id INTEGER PRIMARY KEY,
                    executed_query TEXT NOT NULL, request_url TEXT NOT NULL,
                    run_kind TEXT NOT NULL);
                """
            )
            raw.commit()
            raw.close()
            init_database(path)
            connection = connect(path)
            columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(search_run_details)")
            }
            tables = {
                row["name"]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            version = connection.execute("SELECT version FROM schema_meta").fetchone()["version"]
            connection.close()
        self.assertIn("protocol_version", columns)
        self.assertTrue({"ai_screening", "paper_sheets", "triage_events"} <= tables)
        self.assertEqual(version, SCHEMA_VERSION)


class KeyAndProtocolTests(PipelineTestCase):
    def test_paper_key_is_stable_and_indexed(self) -> None:
        index = paper_key_index(self.connection)
        self.assertEqual(len(index), len(self.paper_ids))
        self.assertEqual(paper_key("doi:10.1/x"), paper_key("doi:10.1/x"))
        self.assertEqual(len(paper_key("doi:10.1/x")), 10)

    def test_protocol_cannot_be_refrozen_with_other_text(self) -> None:
        document = self.root / "protocol.md"
        document.write_bytes(b"version A\r\n")
        first = freeze_protocol(self.connection, version="v1", document=document)
        self.assertEqual(first["status"], "provisional")
        document.write_bytes(b"version A\n")  # same text, other line endings
        freeze_protocol(self.connection, version="v1", document=document)
        document.write_bytes(b"version B\n")
        with self.assertRaises(ValueError):
            freeze_protocol(self.connection, version="v1", document=document)
        self.assertEqual(active_protocol(self.connection)["version"], "v1")


class SyncTests(PipelineTestCase):
    def test_events_follow_formal_or_veille_paths(self) -> None:
        formal, veille, other = self.paper_ids[:3]
        self.add_review_hits([formal, other])
        word = self.connection.execute("SELECT term FROM vocabulary LIMIT 1").fetchone()["term"]
        events = [
            {"id": "e1", "type": "screen", "key": self.key_of(formal), "decision": "include",
             "at": "2026-10-26T08:00:00+00:00"},
            {"id": "e2", "type": "screen", "key": self.key_of(veille), "decision": "exclude",
             "code": "E2", "at": "2026-10-26T08:01:00+00:00"},
            {"id": "e3", "type": "screen", "key": self.key_of(other), "decision": "exclude",
             "code": "E6", "at": "2026-10-26T08:02:00+00:00"},
            {"id": "e4", "type": "vocab", "term": word, "quality": 4,
             "at": "2026-10-26T08:03:00+00:00"},
            {"id": "e5", "type": "read", "key": self.key_of(veille),
             "at": "2026-10-26T08:04:00+00:00"},
            {"id": "e6", "type": "screen", "key": "unknown", "decision": "include",
             "at": "2026-10-26T08:05:00+00:00"},
        ]
        report = apply_events(self.connection, events)
        self.assertEqual(sorted(report.applied), ["e1", "e4", "e5"])
        self.assertEqual(report.triaged, ["e2"])
        self.assertEqual(sorted(event_id for event_id, _ in report.skipped), ["e3", "e6"])
        self.assertEqual(sorted(report.processed_ids), ["e1", "e2", "e3", "e4", "e5", "e6"])
        status = self.connection.execute(
            "SELECT status FROM papers WHERE id=?", (formal,)
        ).fetchone()["status"]
        self.assertEqual(status, "sought")
        reviewer = self.connection.execute(
            "SELECT reviewer FROM screening_events WHERE paper_id=?", (formal,)
        ).fetchone()["reviewer"]
        self.assertEqual(reviewer, "human-telegram")
        queued = {
            int(row["paper_id"]) for row in self.connection.execute("SELECT * FROM reading_queue")
        }
        self.assertEqual(queued, {formal, veille})

    def test_veille_triage_is_carried_once_paper_enters_review(self) -> None:
        paper = self.paper_ids[4]
        apply_events(
            self.connection,
            [{"id": "t1", "type": "screen", "key": self.key_of(paper), "decision": "exclude",
              "code": "E1", "at": "2026-10-20T10:00:00+00:00"}],
        )
        self.assertEqual(carry_triage_into_review(self.connection), 0)
        self.add_review_hits([paper])
        self.assertEqual(carry_triage_into_review(self.connection), 1)
        self.assertEqual(carry_triage_into_review(self.connection), 0)
        event = self.connection.execute(
            "SELECT * FROM screening_events WHERE paper_id=?", (paper,)
        ).fetchone()
        self.assertEqual(event["decision"], "exclude")
        self.assertEqual(event["reason_code"], "E1")
        self.assertIn("2026-10-20", event["rationale"])


class AgentTests(PipelineTestCase):
    def test_full_agent_cycle_with_fake_runner(self) -> None:
        reading = self.paper_ids[:2]
        for paper_id in reading:
            self.add_document(paper_id)
            queue_for_reading(self.connection, paper_id, priority=80, reason="test")
        runner = FakeRunner()
        summary = run_agents(
            self.connection,
            runner,
            workdir=self.root / "work",
            plan=AgentPlan(max_screen=50, batch_size=5, max_read=3),
        )
        self.assertEqual(summary.screened, len(self.paper_ids))
        self.assertEqual(summary.sheets, 2)
        self.assertTrue(summary.synthesis)
        self.assertEqual(summary.errors, [])
        decisions = [
            row["decision"]
            for row in self.connection.execute("SELECT decision FROM ai_screening ORDER BY id")
        ]
        self.assertIn("uncertain", decisions)  # invalid E6 at title/abstract was downgraded
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) AS n FROM screening_events").fetchone()["n"],
            0,
            "AI suggestions must never become screening decisions",
        )
        checks = json.loads(
            self.connection.execute(
                "SELECT checks_json FROM paper_sheets WHERE paper_id=?", (reading[0],)
            ).fetchone()["checks_json"]
        )
        self.assertEqual(checks["summary"]["exact_quote"], 4)
        self.assertEqual(checks["summary"]["not_found"], 1)
        self.assertIsNotNone(
            self.connection.execute(
                "SELECT done_at FROM reading_queue WHERE paper_id=?", (reading[0],)
            ).fetchone()["done_at"]
        )
        self.assertEqual(
            self.connection.execute(
                "SELECT COUNT(*) AS n FROM vocabulary WHERE source_paper_id IS NOT NULL"
            ).fetchone()["n"],
            1,  # "query budget" already exists in the seed vocabulary
        )
        self.assertFalse(synthesis_needed(self.connection))
        statuses = {
            row["task"]: row["status"]
            for row in self.connection.execute("SELECT * FROM agent_runs")
        }
        self.assertEqual(
            statuses,
            {"screening": "ok", "reading": "ok", "synthesis": "ok", "translation": "ok"},
        )
        self.assertEqual(summary.translated, len(self.paper_ids))
        # The word written by the reading agent without French got it from the translator.
        self.assertEqual(
            self.connection.execute(
                "SELECT definition_fr FROM vocabulary WHERE term='top label'"
            ).fetchone()["definition_fr"],
            "FR The predicted class.",
        )

        public = build_public_state(self.connection)
        sheets = build_sheets_state(self.connection)
        bot = build_bot_state(self.connection, public, sheets, site_url="https://x.invalid/")
        self.assertEqual(len(sheets["sheets"]), 2)
        self.assertEqual(len(sheets["synthesis"]["keys"]), 2)
        self.assertEqual(public["agents"]["sheets"], 2)
        self.assertTrue(all(paper["key"] for paper in public["papers"]))
        self.assertEqual(bot["site"], "https://x.invalid")
        self.assertTrue(all(item["stage"] == "veille" for item in bot["queue"]))
        self.assertEqual(bot["queue"][0]["ai"]["relevance"], 5)
        self.assertNotIn("abc123", json.dumps(bot))

    def test_failed_reading_is_logged_and_retried_later(self) -> None:
        paper_id = self.paper_ids[0]
        self.add_document(paper_id)
        queue_for_reading(self.connection, paper_id, priority=80, reason="test")
        summary = run_agents(
            self.connection,
            FakeRunner(fail_reading=True),
            workdir=self.root / "work",
            plan=AgentPlan(max_screen=0, max_read=1, synthesis=False),
        )
        self.assertEqual(summary.sheets, 0)
        self.assertEqual(len(summary.errors), 1)
        attempts = self.connection.execute(
            "SELECT attempts FROM reading_queue WHERE paper_id=?", (paper_id,)
        ).fetchone()["attempts"]
        self.assertEqual(attempts, 1)


class RunnerHelperTests(unittest.TestCase):
    def test_command_is_read_only_and_schema_bound(self) -> None:
        command = ClaudeCodeRunner(model="sonnet").command(
            prompt="hello", schema={"type": "object"}, max_turns=4
        )
        self.assertIn("--json-schema", command)
        self.assertEqual(command[command.index("--tools") + 1], "Read,Grep,Glob")
        self.assertEqual(command[command.index("--permission-mode") + 1], "dontAsk")
        self.assertEqual(command[command.index("--model") + 1], "sonnet")
        self.assertNotIn("--bare", command)  # bare mode ignores subscription OAuth tokens

    def test_cli_output_parsing(self) -> None:
        payload = parse_cli_output('{"type":"result","structured_output":{"a":1}}\n')
        self.assertEqual(payload["structured_output"], {"a": 1})
        self.assertTrue(parse_cli_output("not json")["is_error"])
        self.assertEqual(parse_cli_output(""), {})

    def test_credentials_detection(self) -> None:
        self.assertFalse(credentials_available({}))
        self.assertTrue(credentials_available({"CLAUDE_CODE_OAUTH_TOKEN": "x"}))


class FakeHTTPResponse:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None


def gemini_payload(output: dict | str, model: str = "gemini-test") -> dict:
    text = output if isinstance(output, str) else json.dumps(output)
    return {
        "candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 120, "candidatesTokenCount": 30},
        "modelVersion": model,
    }


class GeminiRunnerTests(unittest.TestCase):
    def make_runner(self, responses: list, models=("busy-model", "good-model")):
        import io
        import urllib.error

        calls: list[dict] = []

        def opener(request, timeout):
            body = json.loads(request.data.decode("utf-8"))
            calls.append({"url": request.full_url, "body": body, "key": request.headers})
            item = responses.pop(0)
            if isinstance(item, int):
                raise urllib.error.HTTPError(
                    request.full_url, item, "error", {}, io.BytesIO(b'{"error": "x"}')
                )
            return FakeHTTPResponse(item)

        from pfe_hla.agents import GeminiRunner

        runner = GeminiRunner(
            api_key="test-key", models=models, sleep=lambda _seconds: None, opener=opener
        )
        return runner, calls

    def test_busy_model_is_retried_then_next_model_answers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            (cwd / "batch-01.json").write_text('[{"key": "k1"}]', encoding="utf-8")
            runner, calls = self.make_runner(
                [503, 503, gemini_payload({"suggestions": []}, model="good-model-001")]
            )
            result = runner.run(
                prompt="Tâche", schema={"type": "object"}, cwd=cwd, max_turns=1, timeout=30
            )
        self.assertEqual(result.output, {"suggestions": []})
        self.assertEqual(result.model, "good-model-001")
        self.assertIn("tokens 120", result.note)
        self.assertEqual(len(calls), 3)
        self.assertIn("busy-model", calls[0]["url"])
        self.assertIn("good-model", calls[2]["url"])
        sent = calls[2]["body"]
        self.assertIn('[{"key": "k1"}]', sent["contents"][0]["parts"][0]["text"])
        self.assertEqual(sent["generationConfig"]["responseJsonSchema"], {"type": "object"})
        self.assertIn("Rôle", sent["systemInstruction"]["parts"][0]["text"])

    def test_retired_model_skips_and_invalid_json_fails_cleanly(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runner, _calls = self.make_runner([404, gemini_payload("not json"), 503])
            with self.assertRaises(AgentError):
                runner.run(
                    prompt="Tâche", schema={"type": "object"}, cwd=Path(directory),
                    max_turns=1, timeout=30,
                )

    def test_oversized_input_is_refused_not_truncated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            (cwd / "fulltext.txt").write_text("x" * 50, encoding="utf-8")
            runner, calls = self.make_runner([])
            runner.max_input_chars = 10
            with self.assertRaises(AgentError):
                runner.run(prompt="T", schema={}, cwd=cwd, max_turns=1, timeout=30)
            self.assertEqual(calls, [])

    def test_backend_selection_prefers_the_free_gemini_key(self) -> None:
        from pfe_hla.agents import build_runner, select_backend

        self.assertEqual(select_backend({"GEMINI_API_KEY": "g"}), "gemini")
        self.assertEqual(
            select_backend({"GEMINI_API_KEY": "g", "CLAUDE_CODE_OAUTH_TOKEN": "c"}), "gemini"
        )
        self.assertEqual(
            select_backend(
                {"GEMINI_API_KEY": "g", "CLAUDE_CODE_OAUTH_TOKEN": "c", "AGENT_BACKEND": "claude"}
            ),
            "claude",
        )
        self.assertIsNone(select_backend({}))
        self.assertIsNone(select_backend({"AGENT_BACKEND": "gemini"}))
        runner = build_runner({"GEMINI_API_KEY": "g"}, model="m1, m2")
        self.assertEqual(runner.models, ("m1", "m2"))


class PdfResolutionTests(unittest.TestCase):
    def resolve(self, **values: str) -> str:
        paper = {"pdf_url": "", "arxiv_id": "", "doi": "", "url": ""}
        paper.update(values)
        return resolve_pdf_url(paper)

    def test_open_access_heuristics(self) -> None:
        self.assertEqual(self.resolve(arxiv_id="2101.00001"), "https://arxiv.org/pdf/2101.00001")
        self.assertEqual(
            self.resolve(doi="10.48550/arxiv.2203.1"), "https://arxiv.org/pdf/2203.1"
        )
        self.assertEqual(
            self.resolve(url="https://aclanthology.org/2020.emnlp-main.498/"),
            "https://aclanthology.org/2020.emnlp-main.498.pdf",
        )
        self.assertEqual(
            self.resolve(doi="10.18653/v1/2020.acl-main.540"),
            "https://aclanthology.org/2020.acl-main.540.pdf",
        )
        self.assertEqual(
            self.resolve(url="https://openreview.net/forum?id=abc-1"),
            "https://openreview.net/pdf?id=abc-1",
        )
        self.assertEqual(self.resolve(pdf_url="http://insecure.example/x.pdf"), "")
        self.assertEqual(self.resolve(url="https://ojs.aaai.org/index.php/AAAI/article/view/1"), "")


if __name__ == "__main__":
    unittest.main()
