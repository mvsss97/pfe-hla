"""Configuration loader with no third-party dependency.

Secrets are read from the process environment or from a local ``.env`` file.
They are never printed by this module.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path: Path | str = ".env") -> None:
    """Load missing environment variables from a small dotenv-compatible file."""

    env_path = Path(path)
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


@dataclass(frozen=True, slots=True)
class Settings:
    database: Path
    timezone: str
    telegram_token: str | None
    telegram_pairing_code: str | None
    telegram_allowed_chat_id: int | None
    site_url: str
    openalex_email: str | None
    semantic_scholar_api_key: str | None

    @classmethod
    def from_env(cls, env_file: Path | str = ".env") -> Settings:
        load_dotenv(env_file)
        chat_id_raw = os.getenv("TELEGRAM_ALLOWED_CHAT_ID", "").strip()
        return cls(
            database=Path(os.getenv("PFE_DATABASE", "data/pfe_hla.db")),
            timezone=os.getenv("PFE_TIMEZONE", "Africa/Algiers"),
            telegram_token=os.getenv("TELEGRAM_BOT_TOKEN") or None,
            telegram_pairing_code=os.getenv("TELEGRAM_PAIRING_CODE") or None,
            telegram_allowed_chat_id=int(chat_id_raw) if chat_id_raw else None,
            site_url=os.getenv("PFE_SITE_URL", "http://localhost:8000"),
            openalex_email=os.getenv("OPENALEX_EMAIL") or None,
            semantic_scholar_api_key=os.getenv("SEMANTIC_SCHOLAR_API_KEY") or None,
        )
