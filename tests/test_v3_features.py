"""Supervisor list, AI-security news, French translations and the reader index."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from pfe_hla.agents import AgentPlan, AgentResult, run_news_summaries, run_translations
from pfe_hla.db import SCHEMA_VERSION, connect, init_database
from pfe_hla.export import export_public_state
from pfe_hla.library import PaperRecord, seed_library
from pfe_hla.news import (
    NewsItem,
    collect_news,
    fresh_alerts,
    parse_aiid,
    parse_github_advisories,
    parse_github_repos,
    parse_kev,
    parse_nvd,
    parse_security_feed,
    recent_news,
    store_items,
)
from pfe_hla.supervisor import Resolution, import_reading_list, supervisor_papers

ROOT = Path(__file__).resolve().parents[1]
HLBB_TITLE = "Generating Natural Language Attacks in a Hard Label Black Box Setting"
NOW = datetime.now(UTC).replace(microsecond=0)


def rss(*items: tuple[str, str]) -> bytes:
    body = "".join(
        f"<item><title>{title}</title><link>https://news.example/{index}</link>"
        f"<description>{text}</description><guid>g{index}</guid>"
        f"<pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate></item>"
        for index, (title, text) in enumerate(items)
    )
    return f"<rss><channel>{body}</channel></rss>".encode()


class DatabaseCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.db_path = self.root / "test.db"
        init_database(self.db_path)
        self.connection = connect(self.db_path)

    def tearDown(self) -> None:
        self.connection.close()
        self.temp_dir.cleanup()


class MigrationTests(DatabaseCase):
    def test_v2_database_gains_french_vocabulary_without_losing_progress(self) -> None:
        seed_library(
            self.connection, ROOT / "data/seed_papers.json", ROOT / "data/seed_vocabulary.json"
        )
        self.connection.execute(
            "UPDATE vocabulary SET repetitions=4, definition_fr='', example_fr='' "
            "WHERE term='black box'"
        )
        self.connection.commit()
        self.connection.close()
        raw = sqlite3.connect(self.db_path)
        raw.executescript(
            """
            ALTER TABLE vocabulary DROP COLUMN definition_fr;
            ALTER TABLE vocabulary DROP COLUMN example_fr;
            DROP TABLE paper_translations;
            UPDATE schema_meta SET version = 2;
            """
        )
        raw.commit()
        raw.close()

        init_database(self.db_path)
        self.connection = connect(self.db_path)
        seed_library(
            self.connection, ROOT / "data/seed_papers.json", ROOT / "data/seed_vocabulary.json"
        )
        word = self.connection.execute(
            "SELECT repetitions, definition_fr, example_fr FROM vocabulary WHERE term='black box'"
        ).fetchone()
        version = self.connection.execute("SELECT version FROM schema_meta").fetchone()[0]
        self.assertEqual(version, SCHEMA_VERSION)
        self.assertEqual(word["repetitions"], 4, "spaced-repetition state is kept")
        self.assertIn("paramètres internes", word["definition_fr"])
        self.assertIn("boîte noire", word["example_fr"])
        tables = {row[0] for row in self.connection.execute("SELECT name FROM sqlite_master")}
        self.assertIn("paper_translations", tables)

    def test_every_seed_word_is_bilingual(self) -> None:
        words = json.loads((ROOT / "data/seed_vocabulary.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(words), 90)
        for word in words:
            self.assertTrue(word["definition_fr"] and word["example_fr"], word["term"])


class NewsParserTests(unittest.TestCase):
    def test_github_repositories_skip_forks_and_unknown_projects(self) -> None:
        items = parse_github_repos(
            {
                "items": [
                    {
                        "full_name": "a/llm-guard",
                        "stargazers_count": 320,
                        "html_url": "https://github.com/a/llm-guard",
                        "description": "Prompt injection scanner",
                        "created_at": "2026-10-20T10:00:00Z",
                        "topics": ["llm"],
                    },
                    {"full_name": "b/fork", "stargazers_count": 999, "fork": True},
                    {"full_name": "c/tiny", "stargazers_count": 2},
                ]
            }
        )
        self.assertEqual([item.external_id for item in items], ["a/llm-guard"])
        self.assertEqual(items[0].severity, "notable")
        self.assertEqual(items[0].extra["stars"], 320)

    def test_only_critical_ai_advisories_are_alerts(self) -> None:
        items = parse_github_advisories(
            [
                {
                    "ghsa_id": "GHSA-1",
                    "summary": "RCE in vLLM",
                    "severity": "critical",
                    "vulnerabilities": [{"package": {"name": "vllm"}}],
                    "html_url": "https://github.com/advisories/GHSA-1",
                },
                {"ghsa_id": "GHSA-2", "summary": "Path traversal in MLflow", "severity": "high"},
                {
                    "ghsa_id": "GHSA-3",
                    "summary": "Duplicate Advisory: RCE in vLLM",
                    "severity": "critical",
                },
            ]
        )
        self.assertEqual(
            [(item.external_id, item.severity) for item in items],
            [("GHSA-1", "alert"), ("GHSA-2", "notable")],
        )

    def test_nvd_keeps_ai_flaws_and_grades_them(self) -> None:
        def cve(identifier: str, text: str, score: float) -> dict[str, Any]:
            return {
                "cve": {
                    "id": identifier,
                    "published": "2026-10-25T10:00:00.000",
                    "descriptions": [{"lang": "en", "value": text}],
                    "metrics": {
                        "cvssMetricV31": [{"cvssData": {"baseScore": score, "baseSeverity": "X"}}]
                    },
                }
            }

        items = parse_nvd(
            {
                "vulnerabilities": [
                    cve("CVE-1", "Prompt injection in an LLM agent framework allows RCE.", 9.8),
                    cve("CVE-2", "A machine learning library mishandles pickles.", 7.5),
                    cve("CVE-3", "A printer driver overflows a buffer.", 9.9),
                ]
            }
        )
        self.assertEqual(
            [(item.external_id, item.severity) for item in items],
            [("CVE-1", "alert"), ("CVE-2", "notable")],
        )

    def test_exploited_flaws_alert_only_when_ai_is_involved(self) -> None:
        since = NOW - timedelta(days=5)
        recent = (NOW - timedelta(days=1)).date().isoformat()
        items = parse_kev(
            {
                "vulnerabilities": [
                    {
                        "cveID": "CVE-A",
                        "vendorProject": "Ollama",
                        "product": "Ollama",
                        "dateAdded": recent,
                        "vulnerabilityName": "LLM server RCE",
                        "shortDescription": "Ollama allows code execution.",
                    },
                    {
                        "cveID": "CVE-B",
                        "vendorProject": "Acme",
                        "product": "Router",
                        "dateAdded": recent,
                        "vulnerabilityName": "Router RCE",
                        "shortDescription": "Command injection.",
                    },
                    {
                        "cveID": "CVE-C",
                        "vendorProject": "Old",
                        "product": "Thing",
                        "dateAdded": "2020-01-01",
                    },
                ]
            },
            since=since,
        )
        self.assertEqual(
            [(item.external_id, item.severity) for item in items],
            [("CVE-A", "alert"), ("CVE-B", "notable")],
        )

    def test_feeds_keep_ai_security_stories(self) -> None:
        articles = parse_security_feed(
            "thehackernews",
            rss(
                ("New jailbreak breaks LLM guardrails", "Researchers attack chatbots."),
                ("Patch Tuesday", "Windows fixes."),
            ),
        )
        self.assertEqual([item.title for item in articles], ["New jailbreak breaks LLM guardrails"])
        self.assertEqual(articles[0].severity, "notable")
        incidents = parse_aiid(
            rss(
                ("Deepfake scam steals money", "A fraud with a cloned voice."),
                ("Chatbot gives bad advice", "Wrong answer."),
            )
        )
        self.assertEqual([item.kind for item in incidents], ["incident"])


class NewsStorageTests(DatabaseCase):
    def test_collection_is_fail_soft_and_deduplicated(self) -> None:
        item = NewsItem(
            source="ghsa",
            kind="vulnerability",
            external_id="GHSA-1",
            title="RCE",
            severity="alert",
            published_at=NOW.isoformat(),
        )

        def broken() -> list[NewsItem]:
            raise OSError("feed down")

        report = collect_news(self.connection, fetchers={"ghsa": lambda: [item], "nvd": broken})
        self.assertEqual(report.inserted, {"ghsa": 1})
        self.assertIn("feed down", report.errors["nvd"])
        again = collect_news(self.connection, fetchers={"ghsa": lambda: [item]})
        self.assertEqual(again.total, 0)

    def test_fresh_alerts_are_read_only_and_keyed_by_source(self) -> None:
        old = (NOW - timedelta(days=9)).isoformat()
        store_items(
            self.connection,
            [
                NewsItem(
                    source="ghsa",
                    kind="vulnerability",
                    external_id="GHSA-new",
                    title="New",
                    severity="alert",
                    published_at=NOW.isoformat(),
                    score=5,
                ),
                NewsItem(
                    source="nvd",
                    kind="vulnerability",
                    external_id="CVE-old",
                    title="Old",
                    severity="alert",
                    published_at=old,
                    score=5,
                ),
                NewsItem(
                    source="github",
                    kind="repo",
                    external_id="a/b",
                    title="Repo",
                    severity="notable",
                ),
            ],
        )
        alerts = fresh_alerts(self.connection)
        self.assertEqual([alert["key"] for alert in alerts], ["ghsa:GHSA-new"])
        self.assertEqual(
            fresh_alerts(self.connection), alerts, "reading alerts never consumes them"
        )
        self.assertEqual(len(recent_news(self.connection)), 3)


class SupervisorTests(DatabaseCase):
    class Resolver:
        def __init__(self) -> None:
            self.calls = 0

        def resolve(self, entry: dict[str, Any]) -> Resolution:
            self.calls += 1
            if entry["id"] == "hlbb":
                return Resolution(
                    PaperRecord(
                        source="arXiv",
                        title=HLBB_TITLE,
                        arxiv_id="2012.14956",
                        url="https://arxiv.org/abs/2012.14956",
                        publication_year=2020,
                    ),
                    "arxiv",
                    1.0,
                )
            return Resolution(None, "none")

    def write_list(self) -> Path:
        path = self.root / "list.json"
        path.write_text(
            json.dumps(
                {
                    "families": {"ga": "Algorithme génétique", "defense": "Défenses"},
                    "papers": [
                        {
                            "id": "hlbb",
                            "short": "HLBB",
                            "title": HLBB_TITLE,
                            "venue": "AAAI",
                            "year": 2021,
                            "family": "ga",
                            "priority": 1,
                            "arxiv": "2012.14956",
                        },
                        {
                            "id": "fgws",
                            "short": "FGWS",
                            "title": "Frequency-Guided Word Substitutions",
                            "venue": "EACL",
                            "year": 2021,
                            "family": "defense",
                            "priority": 3,
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )
        return path

    def test_import_is_idempotent_and_queues_by_priority(self) -> None:
        path = self.write_list()
        resolver = self.Resolver()
        first = import_reading_list(self.connection, path, resolver)
        second = import_reading_list(self.connection, path, resolver)
        self.assertEqual((first.total, first.resolved, first.queued), (2, 1, 1))
        self.assertEqual(second.unresolved, ["FGWS"])
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM papers").fetchone()[0], 2)
        self.assertEqual(resolver.calls, 3, "a matched entry is not looked up again")
        papers = {paper["short"]: paper for paper in supervisor_papers(self.connection)}
        self.assertEqual(papers["HLBB"]["reading"], "queued")
        self.assertEqual(
            papers["HLBB"]["year"], 2021, "the curated AAAI year beats the arXiv preprint"
        )
        self.assertEqual(papers["HLBB"]["pdf"], "https://arxiv.org/pdf/2012.14956")
        self.assertEqual(papers["FGWS"]["reading"], "not_queued")


class FakeTranslator:
    def __init__(self) -> None:
        self.prompts: list[str] = []

    def run(
        self, *, prompt: str, schema: dict, cwd: Path, max_turns: int, timeout: int
    ) -> AgentResult:
        self.prompts.append(prompt)
        if "actualités" in prompt:
            news = json.loads((cwd / "news.json").read_text(encoding="utf-8"))
            items = [
                {"id": item["id"], "titre_fr": f"FR {item['titre']}", "resume_fr": "Résumé."}
                for item in news
            ]
            return AgentResult({"items": items}, model="fake-lite")
        name = next(word.strip("`") for word in prompt.split() if word.strip("`").endswith(".json"))
        records = json.loads((cwd / name).read_text(encoding="utf-8"))
        items = [
            {"key": r["key"], "titre_fr": f"FR {r['title']}", "resume_fr": f"FR {r['abstract']}"}
            for r in records
        ]
        return AgentResult({"items": items}, model="fake-lite")


class TranslationAndExportTests(DatabaseCase):
    def setUp(self) -> None:
        super().setUp()
        seed_library(
            self.connection, ROOT / "data/seed_papers.json", ROOT / "data/seed_vocabulary.json"
        )
        self.connection.commit()

    def test_translations_follow_abstract_changes_and_reach_every_export(self) -> None:
        runner = FakeTranslator()
        plan = AgentPlan(max_translate=100, translate_batch=4)
        written, errors = run_translations(self.connection, runner, self.root / "work", plan)
        papers = self.connection.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        self.assertEqual((written, errors), (papers, []))
        self.assertEqual(run_translations(self.connection, runner, self.root / "work", plan)[0], 0)
        self.connection.execute("UPDATE papers SET abstract='A new abstract.' WHERE id=1")
        self.assertEqual(run_translations(self.connection, runner, self.root / "work", plan)[0], 1)

        store_items(
            self.connection,
            [
                NewsItem(
                    source="ghsa",
                    kind="vulnerability",
                    external_id="GHSA-9",
                    title="Flaw in LangChain",
                    severity="alert",
                    published_at=NOW.isoformat(),
                    summary="Details.",
                )
            ],
        )
        self.assertEqual(
            run_news_summaries(self.connection, runner, self.root / "work", plan)[0], 1
        )
        self.connection.execute("UPDATE papers SET arxiv_id='2012.14956' WHERE id=1")
        self.connection.commit()

        output = self.root / "site" / "state.json"
        export_public_state(self.connection, output, site_url="https://site.invalid")
        state = json.loads(output.read_text(encoding="utf-8"))
        bot = json.loads(output.with_name("bot.json").read_text(encoding="utf-8"))
        news = json.loads(output.with_name("news.json").read_text(encoding="utf-8"))
        reader = json.loads(output.with_name("reader.json").read_text(encoding="utf-8"))

        first = next(paper for paper in state["papers"] if paper["id"] == 1)
        self.assertEqual(first["abstractFr"], "FR A new abstract.")
        self.assertEqual(first["readerUrl"], "https://arxiv.org/pdf/2012.14956")
        self.assertEqual(reader["papers"][first["key"]]["pdf"], "https://arxiv.org/pdf/2012.14956")
        self.assertTrue(all(item["titleFr"] for item in bot["queue"]))
        self.assertTrue(all(word["defFr"] for word in bot["vocabulary"]))
        self.assertEqual(bot["securityNews"][0]["titleFr"], "FR Flaw in LangChain")
        self.assertEqual(news["items"][0]["summaryEn"], "Details.")
        self.assertIn("supervisor", state)


if __name__ == "__main__":
    unittest.main()
