from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from pfe_hla.config import Settings
from pfe_hla.db import connect, init_database
from pfe_hla.library import seed_library
from pfe_hla.telegram import BotService

ROOT = Path(__file__).resolve().parents[1]


class FakeTelegramClient:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.answers: list[tuple[str, str]] = []

    def send_message(
        self,
        chat_id: int,
        text: str,
        *,
        reply_markup: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.messages.append(
            {"chat_id": chat_id, "text": text, "reply_markup": reply_markup}
        )
        return {"message_id": len(self.messages)}

    def answer_callback(self, callback_id: str, text: str) -> None:
        self.answers.append((callback_id, text))

    def get_updates(self, *, offset: int | None = None, timeout: int = 20):
        del offset, timeout
        return []


class TelegramWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test.db"
        init_database(self.db_path)
        self.connection = connect(self.db_path)
        seed_library(
            self.connection,
            ROOT / "data/seed_papers.json",
            ROOT / "data/seed_vocabulary.json",
        )
        cursor = self.connection.execute(
            """
            INSERT INTO search_runs(
                source, query, started_at, finished_at, returned_count,
                inserted_count, status
            ) VALUES ('test-index', 'formal query', '2026-01-01', '2026-01-01', 9, 0, 'ok')
            """
        )
        self.review_run_id = int(cursor.lastrowid)
        self.connection.execute(
            """
            INSERT INTO search_run_details(run_id, executed_query, request_url, run_kind)
            VALUES (?, 'formal query', 'https://example.invalid/query', 'review')
            """,
            (self.review_run_id,),
        )
        self.connection.executemany(
            "INSERT INTO paper_hits(run_id, paper_id, source_rank) VALUES (?, ?, ?)",
            [
                (self.review_run_id, int(row["id"]), rank)
                for rank, row in enumerate(
                    self.connection.execute("SELECT id FROM papers ORDER BY id"), start=1
                )
            ],
        )
        self.connection.commit()
        self.client = FakeTelegramClient()
        self.settings = Settings(
            database=self.db_path,
            timezone="Africa/Algiers",
            telegram_token=None,
            telegram_pairing_code="a-long-test-code",
            telegram_allowed_chat_id=42,
            site_url="https://example.invalid",
            openalex_email=None,
            semantic_scholar_api_key=None,
        )
        self.service = BotService(self.connection, self.settings, self.client)  # type: ignore[arg-type]

    def tearDown(self) -> None:
        self.connection.close()
        self.temp_dir.cleanup()

    def callback(self, data: str) -> dict[str, Any]:
        return {
            "callback_query": {
                "id": "callback-1",
                "data": data,
                "from": {"id": 42},
                "message": {"chat": {"id": 42, "type": "private"}},
            }
        }

    def test_identified_paper_uses_screening_buttons(self) -> None:
        self.assertTrue(self.service.send_paper(42))
        markup = self.client.messages[-1]["reply_markup"]
        callbacks = [button["callback_data"] for button in markup["inline_keyboard"][0]]
        self.assertIn("screen:include:title_abstract:1", callbacks)
        self.assertIn("screen:menu:title_abstract:1", callbacks)

    def test_pilot_only_papers_are_not_offered_for_formal_screening(self) -> None:
        self.connection.execute(
            "UPDATE search_run_details SET run_kind='pilot' WHERE run_id=?",
            (self.review_run_id,),
        )
        self.connection.commit()
        self.assertFalse(self.service.send_paper(42))
        self.assertIsNone(self.client.messages[-1]["reply_markup"])

    def test_read_only_digest_has_no_callback_buttons(self) -> None:
        self.service.send_daily_digest(42, interactive=False)
        self.assertGreaterEqual(len(self.client.messages), 2)
        self.assertTrue(
            all(message["reply_markup"] is None for message in self.client.messages)
        )
        self.assertIn("lecture seule", self.client.messages[0]["text"])

    def test_rejection_requires_and_records_a_reason(self) -> None:
        self.service.handle_update(self.callback("screen:menu:title_abstract:1"))
        reason_markup = self.client.messages[-1]["reply_markup"]
        reason_callbacks = [
            button["callback_data"]
            for row in reason_markup["inline_keyboard"]
            for button in row
        ]
        self.assertIn("screen:reject:title_abstract:E2:1", reason_callbacks)

        self.service.handle_update(self.callback("screen:reject:title_abstract:E2:1"))
        paper = self.connection.execute("SELECT * FROM papers WHERE id=1").fetchone()
        event = self.connection.execute(
            "SELECT * FROM screening_events WHERE paper_id=1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        self.assertEqual(paper["status"], "excluded")
        self.assertEqual(event["reason_code"], "E2")
        self.assertEqual(event["reviewer"], "telegram-human")

    def test_unknown_chat_cannot_modify_state(self) -> None:
        update = self.callback("screen:reject:title_abstract:E2:1")
        update["callback_query"]["message"]["chat"]["id"] = 7
        update["callback_query"]["from"]["id"] = 7
        self.service.handle_update(update)
        paper = self.connection.execute("SELECT * FROM papers WHERE id=1").fetchone()
        self.assertEqual(paper["status"], "identified")
        self.assertIn(("callback-1", "Appareil non autorisé"), self.client.answers)

    def test_pairing_code_cannot_reassign_an_already_paired_bot(self) -> None:
        settings = Settings(
            database=self.db_path,
            timezone="Africa/Algiers",
            telegram_token=None,
            telegram_pairing_code="a-long-test-code",
            telegram_allowed_chat_id=None,
            site_url="https://example.invalid",
            openalex_email=None,
            semantic_scholar_api_key=None,
        )
        service = BotService(self.connection, settings, self.client)  # type: ignore[arg-type]
        service.handle_update(
            {
                "message": {
                    "chat": {"id": 42, "type": "private"},
                    "from": {"id": 42},
                    "text": "/start a-long-test-code",
                }
            }
        )
        service.handle_update(
            {
                "message": {
                    "chat": {"id": 43, "type": "private"},
                    "from": {"id": 43},
                    "text": "/start a-long-test-code",
                }
            }
        )
        stored = self.connection.execute(
            "SELECT value FROM telegram_state WHERE key='authorized_chat_id'"
        ).fetchone()
        self.assertEqual(stored["value"], "42")

    def test_group_chat_is_never_authorized(self) -> None:
        update = self.callback("screen:reject:title_abstract:E2:1")
        update["callback_query"]["message"]["chat"] = {
            "id": -10042,
            "type": "supergroup",
        }
        self.service.handle_update(update)
        paper = self.connection.execute("SELECT status FROM papers WHERE id=1").fetchone()
        self.assertEqual(paper["status"], "identified")


if __name__ == "__main__":
    unittest.main()
