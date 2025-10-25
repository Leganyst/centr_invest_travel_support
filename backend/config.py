"""Environment-backed configuration helpers."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(slots=True)
class Settings:
    port: int
    otm_api_key: str | None
    dgis_api_key: str | None
    dgis_locale: str
    dgis_page_size: int
    dgis_max_pages: int
    dgis_default_query: str
    cache_ttl_places_sec: int
    cache_dir: str
    llm_api_base: str | None
    llm_api_key: str | None
    llm_model: str | None

    @classmethod
    def load(cls) -> "Settings":
        return cls(
            port=int(os.getenv("PORT", "8080")),
            otm_api_key=os.getenv("OTM_API_KEY"),
            dgis_api_key=os.getenv("DGIS_API_KEY"),
            dgis_locale=os.getenv("DGIS_LOCALE", "ru_RU"),
            dgis_page_size=int(os.getenv("DGIS_PAGE_SIZE", "10")),
            dgis_max_pages=int(os.getenv("DGIS_MAX_PAGES", "5")),
            dgis_default_query=os.getenv("DGIS_DEFAULT_Q", "достопримечательности"),
            cache_ttl_places_sec=int(os.getenv("CACHE_TTL_PLACES_SEC", "86400")),
            cache_dir=os.getenv("CACHE_DIR", "./cache"),
            llm_api_base=os.getenv("LLM_API_BASE"),
            llm_api_key=os.getenv("LLM_API_KEY"),
            llm_model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        )

    @property
    def llm_enabled(self) -> bool:
        return bool(self.llm_api_base and self.llm_api_key)

    @property
    def dgis_enabled(self) -> bool:
        return bool(self.dgis_api_key)
