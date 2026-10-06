"""Minimal Telegram Bot API adapter with secure one-time pairing.

The bot deliberately has no dependency on a Telegram SDK. The token is read
from the environment and is never persisted in SQLite or rendered in output.
"""

from __future__ import annotations

import hmac
import html
import json
import sqlite3
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from pfe_hla.config import Settings
from pfe_hla.english import due_words, format_word_card, record_review
from pfe_hla.library import utc_now
from pfe_hla.prisma import compute_prisma_counts
from pfe_hla.screening import (
    FINAL_EXCLUSION_CODES,
    FULL_TEXT_EXCLUSION_CODES,
    TITLE_ABSTRACT_EXCLUSION_CODES,
    apply_screening_decision,
    record_final_decision,
)

EXCLUSION_REASONS = {
    "E1": "Modalité non textuelle",
    "E2": "Hors attaque/robustesse NLP",
    "E3": "Hors fenêtre temporelle",
    "E4": "Langue non admise",
    "E5": "Pas une étude scientifique",
    "E6": "Hors sujet après lecture",
    "E7": "Texte intégral indisponible",
    "E8": "Doublon",
}


class TelegramError(RuntimeError):
    """Raised for a rejected or malformed Telegram Bot API response."""


class TelegramClient:
    def __init__(self, token: str) -> None:
        if not token or ":" not in token:
            raise ValueError("A valid TELEGRAM_BOT_TOKEN is required")
        self._base_url = f"https://api.telegram.org/bot{token}/"

    def call(self, method: str, payload: dict[str, Any] | None = None) -> Any:
        body = json.dumps(payload or {}).encode("utf-8")
        request = urllib.request.Request(
            self._base_url + method,
            data=body,
            headers={"Content-Type": "application/json", "User-Agent": "PFE-HLA/0.1"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=40) as response:  # noqa: S310
                result = json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            raise TelegramError(f"Telegram request failed: {type(exc).__name__}") from exc
        if not result.get("ok"):
            description = result.get("description", "unknown Telegram error")
            raise TelegramError(str(description))
        return result.get("result")

    def send_message(
        self,
        chat_id: int,
        text: str,
        *,
        reply_markup: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text[:4096],
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        return self.call("sendMessage", payload)

    def answer_callback(self, callback_id: str, text: str) -> None:
        self.call("answerCallbackQuery", {"callback_query_id": callback_id, "text": text[:200]})

    def get_updates(self, *, offset: int | None = None, timeout: int = 20) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {
            "timeout": timeout,
            "allowed_updates": ["message", "callback_query"],
        }
        if offset is not None:
            payload["offset"] = offset
        return list(self.call("getUpdates", payload) or [])


@dataclass(slots=True)
class BotService:
    connection: sqlite3.Connection
    settings: Settings
    client: TelegramClient

    def _state_get(self, key: str) -> str | None:
        row = self.connection.execute(
            "SELECT value FROM telegram_state WHERE key=?", (key,)
        ).fetchone()
        return str(row["value"]) if row else None

    def _state_set(self, key: str, value: str) -> None:
        self.connection.execute(
            """
            INSERT INTO telegram_state(key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
            """,
            (key, value, utc_now()),
        )

    def authorized_chat_id(self) -> int | None:
        if self.settings.telegram_allowed_chat_id is not None:
            return self.settings.telegram_allowed_chat_id
        stored = self._state_get("authorized_chat_id")
        return int(stored) if stored else None

    def _is_authorized(self, chat_id: int, user_id: int, chat_type: str) -> bool:
        allowed = self.authorized_chat_id()
        return (
            chat_type == "private"
            and user_id == chat_id
            and allowed is not None
            and hmac.compare_digest(str(chat_id), str(allowed))
        )

    def _try_pair(self, chat_id: int, text: str) -> bool:
        if self.authorized_chat_id() is not None:
            return False
        parts = text.strip().split(maxsplit=1)
        supplied = parts[1].strip() if len(parts) == 2 else ""
        expected = self.settings.telegram_pairing_code or ""
        placeholder = "replace-with-a-long-random-code"
        if (
            len(expected) < 16
            or expected == placeholder
            or not supplied
            or not hmac.compare_digest(supplied, expected)
        ):
            return False
        self._state_set("authorized_chat_id", str(chat_id))
        self.connection.commit()
        self.client.send_message(
            chat_id,
            "✅ Appareil associé. Supprime maintenant le message qui contenait "
            "le code d'association.",
        )
        return True

    @staticmethod
    def _paper_buttons(paper_id: int, status: str) -> dict[str, Any]:
        if status in {"identified", "screened"}:
            return {
                "inline_keyboard": [
                    [
                        {
                            "text": "→ Chercher le PDF",
                            "callback_data": f"screen:include:title_abstract:{paper_id}",
                        },
                        {
                            "text": "× Exclure…",
                            "callback_data": f"screen:menu:title_abstract:{paper_id}",
                        },
                    ]
                ]
            }
        if status == "sought":
            return {
                "inline_keyboard": [
                    [
                        {
                            "text": "✓ Texte éligible",
                            "callback_data": f"screen:include:full_text:{paper_id}",
                        },
                        {
                            "text": "× Exclure…",
                            "callback_data": f"screen:menu:full_text:{paper_id}",
                        },
                    ]
                ]
            }
        return {
            "inline_keyboard": [
                [
                    {"text": "★ Inclure", "callback_data": f"decision:keep:{paper_id}"},
                    {"text": "× Rejeter…", "callback_data": f"decision:menu:{paper_id}"},
                ]
            ]
        }

    @staticmethod
    def _reason_buttons(*, scope: str, stage: str | None, paper_id: int) -> dict[str, Any]:
        rows: list[list[dict[str, str]]] = []
        if scope == "decision":
            allowed_codes = FINAL_EXCLUSION_CODES
        elif stage == "title_abstract":
            allowed_codes = TITLE_ABSTRACT_EXCLUSION_CODES
        elif stage == "full_text":
            allowed_codes = FULL_TEXT_EXCLUSION_CODES
        else:
            raise ValueError("Unknown screening stage")
        items = [
            (code, label)
            for code, label in EXCLUSION_REASONS.items()
            if code in allowed_codes
        ]
        for index in range(0, len(items), 2):
            row = []
            for code, label in items[index : index + 2]:
                if scope == "screen":
                    callback_data = f"screen:reject:{stage}:{code}:{paper_id}"
                else:
                    callback_data = f"decision:reject:{code}:{paper_id}"
                row.append({"text": f"{code} · {label}", "callback_data": callback_data})
            rows.append(row)
        return {"inline_keyboard": rows}

    @staticmethod
    def _word_buttons(vocabulary_id: int) -> dict[str, Any]:
        return {
            "inline_keyboard": [
                [
                    {"text": "À revoir", "callback_data": f"vocab:2:{vocabulary_id}"},
                    {"text": "Difficile", "callback_data": f"vocab:3:{vocabulary_id}"},
                    {"text": "Bien", "callback_data": f"vocab:4:{vocabulary_id}"},
                    {"text": "Facile", "callback_data": f"vocab:5:{vocabulary_id}"},
                ]
            ]
        }

    def _next_paper(self) -> sqlite3.Row | None:
        last_raw = self._state_get("last_paper_id")
        last_id = int(last_raw) if last_raw else 0
        row = self.connection.execute(
            """
            SELECT * FROM papers
            WHERE status IN ('identified', 'screened', 'sought', 'assessed') AND id > ?
              AND EXISTS (
                SELECT 1 FROM paper_hits
                JOIN search_runs ON search_runs.id=paper_hits.run_id
                JOIN search_run_details ON search_run_details.run_id=search_runs.id
                WHERE paper_hits.paper_id=papers.id
                  AND search_runs.status='ok'
                  AND search_run_details.run_kind='review'
              )
            ORDER BY id LIMIT 1
            """,
            (last_id,),
        ).fetchone()
        if row is None:
            row = self.connection.execute(
                """
                SELECT * FROM papers
                WHERE status IN ('identified', 'screened', 'sought', 'assessed')
                  AND EXISTS (
                    SELECT 1 FROM paper_hits
                    JOIN search_runs ON search_runs.id=paper_hits.run_id
                    JOIN search_run_details ON search_run_details.run_id=search_runs.id
                    WHERE paper_hits.paper_id=papers.id
                      AND search_runs.status='ok'
                      AND search_run_details.run_kind='review'
                  )
                ORDER BY id LIMIT 1
                """
            ).fetchone()
        if row:
            self._state_set("last_paper_id", str(row["id"]))
            self.connection.commit()
        return row

    def send_paper(self, chat_id: int, *, interactive: bool = True) -> bool:
        paper = self._next_paper()
        if paper is None:
            self.client.send_message(
                chat_id, "Aucun article en attente. Lance d'abord la collecte."
            )
            return False
        title = html.escape(paper["title"])
        venue = html.escape(paper["venue"] or paper["source"])
        summary = html.escape((paper["abstract"] or "Résumé non disponible")[:900])
        url = html.escape(paper["url"] or paper["pdf_url"], quote=True)
        link = f'\n<a href="{url}">Ouvrir la source primaire</a>' if url else ""
        text = (
            f"📄 <b>{title}</b>\n"
            f"{paper['publication_year'] or 'année inconnue'} · {venue}\n\n"
            f"{summary}{link}\n\n"
            "Décide seulement après avoir vérifié le texte intégral."
        )
        self.client.send_message(
            chat_id,
            text,
            reply_markup=(
                self._paper_buttons(int(paper["id"]), str(paper["status"]))
                if interactive
                else None
            ),
        )
        return True

    def send_words(self, chat_id: int, *, limit: int = 3, interactive: bool = True) -> int:
        words = due_words(self.connection, limit=limit)
        if not words:
            self.client.send_message(chat_id, "Aucun mot à réviser aujourd'hui. 🌱")
            return 0
        for word in words:
            self.client.send_message(
                chat_id,
                format_word_card(word),
                reply_markup=(self._word_buttons(int(word["id"])) if interactive else None),
            )
        return len(words)

    def send_stats(self, chat_id: int) -> None:
        counts = compute_prisma_counts(self.connection)
        self.client.send_message(
            chat_id,
            "📊 <b>Revue PRISMA</b>\n"
            f"Notices identifiées : {counts.identified}\n"
            f"Notices uniques : {counts.unique_records}\n"
            f"Rapports recherchés : {counts.reports_sought}\n"
            f"Rapports évalués : {counts.reports_assessed}\n"
            f"Études incluses : {counts.included}\n"
            f"À trier : {counts.pending_screening}",
        )

    def send_daily_digest(
        self, chat_id: int | None = None, *, interactive: bool = True
    ) -> None:
        recipient = chat_id or self.authorized_chat_id()
        if recipient is None:
            raise TelegramError("No paired Telegram chat. Use /start PAIRING_CODE first.")
        mode_note = (
            ""
            if interactive
            else "\nMode lecture seule : réponds via le poller relié à la base durable."
        )
        self.client.send_message(
            recipient,
            "🧭 <b>Session du jour · 15 minutes</b>\n"
            "1. Évalue un article.\n2. Révise trois mots.\n3. Note une décision vérifiable."
            + mode_note,
        )
        self.send_paper(recipient, interactive=interactive)
        self.send_words(recipient, limit=3, interactive=interactive)

    def _help(self, chat_id: int) -> None:
        self.client.send_message(
            chat_id,
            "<b>Commandes</b>\n"
            "/today — article + vocabulaire du jour\n"
            "/more — article suivant\n"
            "/papers — cinq articles en attente\n"
            "/search mots — chercher dans la bibliothèque\n"
            "/words — trois mots à réviser\n"
            "/stats — compteurs PRISMA\n"
            "/site — ouvrir le tableau de bord\n"
            "/help — cette aide",
        )

    def _handle_command(self, chat_id: int, text: str) -> None:
        command, _, argument = text.strip().partition(" ")
        command = command.split("@", 1)[0].lower()
        if command in {"/start", "/help"}:
            self._help(chat_id)
        elif command == "/today":
            self.send_daily_digest(chat_id)
        elif command == "/more":
            self.send_paper(chat_id)
        elif command == "/words":
            self.send_words(chat_id)
        elif command == "/stats":
            self.send_stats(chat_id)
        elif command == "/site":
            safe_url = html.escape(self.settings.site_url, quote=True)
            self.client.send_message(chat_id, f'<a href="{safe_url}">Ouvrir le tableau de bord</a>')
        elif command == "/papers":
            rows = list(
                self.connection.execute(
                    """
                    SELECT id, title, publication_year FROM papers
                    WHERE status != 'excluded'
                      AND EXISTS (
                        SELECT 1 FROM paper_hits
                        JOIN search_runs ON search_runs.id=paper_hits.run_id
                        JOIN search_run_details ON search_run_details.run_id=search_runs.id
                        WHERE paper_hits.paper_id=papers.id
                          AND search_runs.status='ok'
                          AND search_run_details.run_kind='review'
                      )
                    ORDER BY publication_year DESC, title LIMIT 5
                    """
                )
            )
            body = "\n".join(
                f"• #{row['id']} {html.escape(row['title'])} ({row['publication_year'] or '?'})"
                for row in rows
            )
            self.client.send_message(chat_id, "📚 <b>Bibliothèque</b>\n" + (body or "Vide"))
        elif command == "/search":
            term = argument.strip()
            if len(term) < 2:
                self.client.send_message(chat_id, "Usage : /search hard label")
                return
            like = f"%{term}%"
            rows = list(
                self.connection.execute(
                    """
                    SELECT id, title FROM papers WHERE title LIKE ? OR abstract LIKE ?
                    ORDER BY publication_year DESC LIMIT 8
                    """,
                    (like, like),
                )
            )
            body = "\n".join(f"• #{row['id']} {html.escape(row['title'])}" for row in rows)
            self.client.send_message(chat_id, body or "Aucun résultat.")
        else:
            self._help(chat_id)

    def _handle_callback(self, callback: dict[str, Any]) -> None:
        callback_id = str(callback.get("id", ""))
        message = callback.get("message") or {}
        chat = message.get("chat") or {}
        chat_id = int(chat.get("id", 0))
        user_id = int((callback.get("from") or {}).get("id", 0))
        if not self._is_authorized(chat_id, user_id, str(chat.get("type", ""))):
            self.client.answer_callback(callback_id, "Appareil non autorisé")
            return
        parts = str(callback.get("data", "")).split(":")
        try:
            if len(parts) == 4 and parts[:2] == ["screen", "menu"]:
                stage = parts[2]
                paper_id = int(parts[3])
                self.client.answer_callback(callback_id, "Choisis un motif")
                self.client.send_message(
                    chat_id,
                    "Motif d'exclusion obligatoire :",
                    reply_markup=self._reason_buttons(
                        scope="screen", stage=stage, paper_id=paper_id
                    ),
                )
            elif len(parts) == 4 and parts[:2] == ["screen", "include"]:
                stage = parts[2]
                paper_id = int(parts[3])
                rationale = (
                    "Titre/résumé pertinent; texte intégral à récupérer."
                    if stage == "title_abstract"
                    else "Texte intégral jugé éligible; extraction à compléter."
                )
                apply_screening_decision(
                    self.connection,
                    paper_id=paper_id,
                    stage=stage,
                    decision="include",
                    reason_code=None,
                    rationale=rationale,
                    reviewer="telegram-human",
                )
                self.connection.commit()
                self.client.answer_callback(callback_id, "Décision de tri enregistrée")
            elif len(parts) == 5 and parts[:2] == ["screen", "reject"]:
                stage = parts[2]
                code = parts[3]
                paper_id = int(parts[4])
                if code not in EXCLUSION_REASONS:
                    raise ValueError("Unknown exclusion code")
                apply_screening_decision(
                    self.connection,
                    paper_id=paper_id,
                    stage=stage,
                    decision="exclude",
                    reason_code=code,
                    rationale=EXCLUSION_REASONS[code],
                    reviewer="telegram-human",
                )
                self.connection.commit()
                self.client.answer_callback(callback_id, f"Exclusion {code} enregistrée")
            elif len(parts) == 3 and parts[:2] == ["decision", "menu"]:
                paper_id = int(parts[2])
                self.client.answer_callback(callback_id, "Choisis un motif")
                self.client.send_message(
                    chat_id,
                    "Motif de rejet obligatoire :",
                    reply_markup=self._reason_buttons(
                        scope="decision", stage=None, paper_id=paper_id
                    ),
                )
            elif len(parts) == 3 and parts[:2] == ["decision", "keep"]:
                paper_id = int(parts[2])
                record_final_decision(
                    self.connection,
                    paper_id=paper_id,
                    decision="keep",
                    reason_code=None,
                    note="Final human inclusion from Telegram.",
                    channel="telegram",
                )
                self.connection.commit()
                self.client.answer_callback(callback_id, "Article inclus")
            elif len(parts) == 4 and parts[:2] == ["decision", "reject"]:
                code = parts[2]
                paper_id = int(parts[3])
                if code not in EXCLUSION_REASONS:
                    raise ValueError("Unknown exclusion code")
                record_final_decision(
                    self.connection,
                    paper_id=paper_id,
                    decision="reject",
                    reason_code=code,
                    note=EXCLUSION_REASONS[code],
                    channel="telegram",
                )
                self.connection.commit()
                self.client.answer_callback(callback_id, f"Rejet {code} enregistré")
            elif len(parts) == 3 and parts[0] == "vocab":
                quality = int(parts[1])
                vocabulary_id = int(parts[2])
                schedule = record_review(
                    self.connection, vocabulary_id=vocabulary_id, quality=quality
                )
                self.connection.commit()
                self.client.answer_callback(
                    callback_id, f"Prochaine révision dans {schedule.interval_days} j"
                )
            else:
                self.client.answer_callback(callback_id, "Action inconnue")
        except (KeyError, ValueError, sqlite3.DatabaseError):
            self.connection.rollback()
            self.client.answer_callback(callback_id, "Action impossible")

    def handle_update(self, update: dict[str, Any]) -> None:
        if "callback_query" in update:
            self._handle_callback(update["callback_query"])
            return
        message = update.get("message") or {}
        chat = message.get("chat") or {}
        chat_id = int(chat.get("id", 0))
        user_id = int((message.get("from") or {}).get("id", 0))
        text = str(message.get("text", ""))
        if not chat_id or not text.startswith("/"):
            return
        chat_type = str(chat.get("type", ""))
        if chat_type != "private" or user_id != chat_id:
            return
        if not self._is_authorized(chat_id, user_id, chat_type):
            if text.startswith("/start") and self._try_pair(chat_id, text):
                return
            self.client.send_message(
                chat_id,
                "🔒 Bot privé. Utilise /start suivi du code d'association défini dans .env.",
            )
            return
        self._handle_command(chat_id, text)

    def poll_once(self, *, timeout: int = 20) -> int:
        offset_raw = self._state_get("update_offset")
        offset = int(offset_raw) if offset_raw else None
        updates = self.client.get_updates(offset=offset, timeout=timeout)
        for update in updates:
            self.handle_update(update)
            self._state_set("update_offset", str(int(update["update_id"]) + 1))
            self.connection.commit()
        return len(updates)
