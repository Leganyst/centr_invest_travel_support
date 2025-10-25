"""Configuration helpers for the Telegram bot."""

from dataclasses import dataclass
import os


@dataclass
class Settings:
    telegram_bot_token: str
    backend_url: str

    @classmethod
    def load(cls) -> "Settings":
        token = os.getenv("TELEGRAM_BOT_TOKEN")
        if not token:
            raise RuntimeError("TELEGRAM_BOT_TOKEN is not set")
        backend_url = os.getenv("BACKEND_URL", "http://localhost:8080")
        return cls(telegram_bot_token=token, backend_url=backend_url)
