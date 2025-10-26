# Lightweight LLM integration with graceful fallbacks + web facts (Wikipedia).
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import httpx
import asyncio

from config import Settings
from tags_vocab import allowed_tags, normalize_tags
from cache import cache_get, cache_set, make_key

ConversationResponse = Dict[str, Any]

# --- Wikipedia endpoints & cache ---
MW_ACTION = "https://{lang}.wikipedia.org/w/api.php"
MW_REST   = "https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}"
WIKI_CACHE_TTL_SEC = 6 * 3600  # 6 часов


class LLMClient:
    """Wrapper around a chat-completions style API + lightweight web context."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    # -------- feature flags ----------
    def is_enabled(self) -> bool:
        return self._settings.llm_enabled

    # -------- public API -------------
    async def next_step(self, known_prefs: dict[str, Any]) -> ConversationResponse:
        normalized_prefs = dict(known_prefs)
        if "tags" in normalized_prefs:
            normalized_prefs["tags"] = normalize_tags(normalized_prefs.get("tags", []))

        if self.is_enabled():
            try:
                return await self._call_conversation_api(normalized_prefs)
            except Exception as exc:  # pragma: no cover - network guardrail
                return self._fallback_next_step(
                    normalized_prefs, error=f"LLM недоступен: {exc}"
                )
        return self._fallback_next_step(normalized_prefs)

    async def explain_route(self, prefs: dict[str, Any], stops: list[dict[str, Any]]) -> str:
        """Генерация короткого объяснения маршрута. Подтягиваем факты из Википедии."""
        if "tags" in prefs:
            prefs = {**prefs, "tags": normalize_tags(prefs.get("tags", []))}

        city = prefs.get("city") or "Ростов-на-Дону"

        # Сбор «web_facts»: 1–2 факта на каждую из первых остановок
        try:
            web_facts = await self._build_web_context(city, stops)
        except Exception as exc:
            web_facts = {"per_stop": [], "note": f"web facts error: {exc}"}

        if self.is_enabled():
            try:
                return await self._call_explain_api(prefs, stops, web_facts=web_facts)
            except Exception as exc:  # pragma: no cover - network guardrail
                return self._fallback_explain(prefs, stops, error=str(exc))
        return self._fallback_explain(prefs, stops)

    # -------- chat backends ----------
    async def _call_conversation_api(self, known_prefs: dict[str, Any]) -> ConversationResponse:
        messages = [
            {
                "role": "system",
                "content": (
                    "Ты ассистент, который собирает параметры для планирования "
                    "однодневного культурного маршрута по Ростову-на-Дону. "
                    "Отвечай строго валидным JSON без пояснений. "
                    "Форматы ответов:\n"
                    "ASK: {\"mode\":\"ask\",\"question\":\"...\",\"field\":\"...\"," 
                    "\"input\":\"date|single|multiselect\",\"options\":[...]}\n"
                    "READY: {\"mode\":\"ready\",\"prefs\":{\"date\":\"YYYY-MM-DD\","
                    "\"city\":\"...\",\"tags\":[allowed],\"budget\":\"low|medium|high\","
                    "\"pace\":\"relaxed|normal|fast\"}}\n"
                    "Разрешённые теги: "
                    f"{', '.join(allowed_tags())}. При необходимости подсказывай варианты из списка."
                ),
            },
            {
                "role": "user",
                "content": json.dumps({"known_prefs": known_prefs}, ensure_ascii=False),
            },
        ]
        content = await self._call_chat_api(messages)
        return _safe_json_loads(content, default=self._fallback_next_step(known_prefs))

    async def _call_explain_api(
        self,
        prefs: dict[str, Any],
        stops: list[dict[str, Any]],
        *,
        web_facts: Optional[dict] = None,
    ) -> str:
        """
        Объяснение маршрута. Если переданы web_facts — модель должна опираться ТОЛЬКО на них.
        Просим 2–4 предложения и список источников вида [1], [2].
        """
        payload = {
            "prefs": {
                "city": prefs.get("city"),
                "tags": prefs.get("tags", []),
            },
            "stops": [
                {"name": s.get("name"), "lat": s.get("lat"), "lon": s.get("lon")}
                for s in stops
            ],
            "web_facts": web_facts or {"per_stop": []},
        }

        system = (
            "Ты экскурсовод. Используй ТОЛЬКО факты из 'web_facts' (ни одного факта из головы). "
            "Пиши кратко по-русски: 2–4 предложения. "
            "Не повторяй названия всех остановок подряд — дай суть и атмосферу. "
            "В конце добавь раздел 'Источники' со сносками [1], [2], ... по URL из web_facts. "
            "Если фактов мало, честно скажи об этом одной фразой и всё равно добавь 'Источники'."
        )

        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ]
        content = await self._call_chat_api(messages)
        return content.strip()

    async def _call_chat_api(self, messages: list[dict[str, Any]]) -> str:
        api_base = (self._settings.llm_api_base or "").rstrip("/")
        url = f"{api_base}/chat/completions"
        headers = {"Authorization": f"Bearer {self._settings.llm_api_key}"}
        payload = {
            "model": self._settings.llm_model,
            "messages": messages,
            "temperature": 0.2,
        }
        async with httpx.AsyncClient(timeout=40) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
        return data["choices"][0]["message"]["content"]

    # -------- fallbacks -------------
    def _fallback_next_step(
        self, known_prefs: dict[str, Any], error: str | None = None
    ) -> ConversationResponse:
        flow = [
            {
                "field": "date",
                "question": "На какой день планируем поездку? Формат YYYY-MM-DD.",
                "input": "date",
                "options": [],
            },
            {
                "field": "tags",
                "question": "Что интересует? Можете выбрать несколько вариантов.",
                "input": "multiselect",
                "options": allowed_tags(),
            },
            {
                "field": "budget",
                "question": "Какой бюджет учитывать? (low / medium / high)",
                "input": "single",
                "options": ["low", "medium", "high"],
            },
            {
                "field": "pace",
                "question": "Какой темп прогулки комфортен? (relaxed / normal / fast)",
                "input": "single",
                "options": ["relaxed", "normal", "fast"],
            },
        ]

        normalized = dict(known_prefs)
        if "tags" in normalized:
            normalized["tags"] = normalize_tags(normalized.get("tags", []))
        if "city" not in normalized:
            normalized["city"] = "Ростов-на-Дону"

        for step in flow:
            value = normalized.get(step["field"])
            if not value:
                response: ConversationResponse = {
                    "mode": "ask",
                    "question": step["question"],
                    "field": step["field"],
                    "input": step["input"],
                    "options": step["options"],
                    "known_prefs": normalized,
                }
                if error:
                    response["note"] = error
                return response

        prefs = {
            "date": normalized["date"],
            "city": normalized.get("city", "Ростов-на-Дону"),
            "tags": normalize_tags(normalized.get("tags", [])),
            "budget": normalized.get("budget", "medium"),
            "pace": normalized.get("pace", "normal"),
        }
        response = {"mode": "ready", "prefs": prefs}
        if error:
            response["note"] = error
        return response

    def _fallback_explain(
        self, prefs: dict[str, Any], stops: list[dict[str, Any]], error: str | None = None
    ) -> str:
        if not stops:
            return "Маршрут пока пуст — попробуйте выбрать другие интересы."
        first = stops[0]["name"]
        last = stops[-1]["name"] if len(stops) > 1 else first
        parts = [
            f"Начнём с {first}, чтобы сразу погрузиться в атмосферу города.",
            f"Далее маршрут ведёт через ещё {max(len(stops) - 2, 0)} остановок и завершится в {last}.",
        ]
        if error:
            parts.append(f"(Подсказка LLM недоступна: {error})")
        # Добавим «Источники» пустым разделом, чтобы фронт выглядел консистентно
        parts.append("Источники: (нет доступных ссылок)")
        return " ".join(parts)

    # -------- web facts (Wikipedia) --------
    async def _mw_geosearch(
        self, lat: float, lon: float, *, lang: str = "ru", radius_m: int = 1500, limit: int = 5
    ) -> List[dict]:
        """Ищем ближайшие статьи вокруг точки (lat,lon)."""
        params = {
            "action": "query", "format": "json", "list": "geosearch",
            "gscoord": f"{lat}|{lon}", "gsradius": str(radius_m), "gslimit": str(limit)
        }
        key = make_key(
            "wiki_geosearch",
            {"lat": round(lat, 5), "lon": round(lon, 5), "lang": lang, "r": radius_m, "n": limit},
        )
        cached = cache_get(self._settings.cache_dir, key)
        if cached is not None:
            return cached
        async with httpx.AsyncClient(timeout=12) as cl:
            r = await cl.get(MW_ACTION.format(lang=lang), params=params)
            r.raise_for_status()
            data = r.json().get("query", {}).get("geosearch", []) or []
        cache_set(self._settings.cache_dir, key, data, WIKI_CACHE_TTL_SEC)
        return data

    async def _mw_summary(self, title: str, *, lang: str = "ru") -> Optional[dict]:
        """Краткое описание статьи + URL."""
        key = make_key("wiki_summary", {"title": title, "lang": lang})
        cached = cache_get(self._settings.cache_dir, key)
        if cached is not None:
            return cached
        url = MW_REST.format(lang=lang, title=quote(title))
        async with httpx.AsyncClient(timeout=12) as cl:
            r = await cl.get(url, headers={"accept": "application/json"})
            if r.status_code == 404:
                return None
            r.raise_for_status()
            j = r.json()
        info = {
            "title": j.get("title") or title,
            "extract": (j.get("extract") or "").strip(),
            "url": j.get("content_urls", {}).get("desktop", {}).get("page"),
        }
        cache_set(self._settings.cache_dir, key, info, WIKI_CACHE_TTL_SEC)
        return info

    @staticmethod
    def _tokenize(s: str) -> List[str]:
        return [t for t in "".join(ch.lower() if ch.isalnum() else " " for ch in (s or "")).split() if t]

    @classmethod
    def _best_geosearch_match(cls, stop_name: str, candidates: List[dict]) -> Optional[str]:
        """
        Выбираем лучшую статью: по пересечению токенов названия остановки и кандидата.
        Если нет пересечения — берём самый близкий (первый в списке).
        """
        if not candidates:
            return None
        stop_tokens = set(cls._tokenize(stop_name))
        scored: List[Tuple[float, str]] = []
        for c in candidates:
            title = c.get("title", "")
            cand_tokens = set(cls._tokenize(title))
            overlap = len(stop_tokens & cand_tokens)
            # Wikipedia geosearch не всегда возвращает дистанцию стабильно — весим только overlap
            scored.append((float(overlap), title))
        scored.sort(key=lambda x: (x[0],), reverse=True)
        best_title = scored[0][1] if scored else candidates[0].get("title")
        return best_title

    @staticmethod
    def _shorten(text: str, limit: int = 320) -> str:
        t = (text or "").strip()
        if len(t) <= limit:
            return t
        return t[:limit].rstrip(" .,:;") + "…"

    async def _facts_for_stop(self, stop: dict) -> Optional[dict]:
        """Одна «карточка фактов» по остановке: 1 короткий абзац + источник."""
        try:
            lat = float(stop.get("lat"))
            lon = float(stop.get("lon"))
        except Exception:
            return None

        # Сначала ru, затем en
        for lang in ("ru", "en"):
            try:
                near = await self._mw_geosearch(lat, lon, lang=lang, radius_m=1500, limit=5)
                title = self._best_geosearch_match(stop.get("name", ""), near) or (near[0]["title"] if near else None)
                if not title:
                    continue
                summ = await self._mw_summary(title, lang=lang)
                if not summ or not summ.get("extract"):
                    continue
                extract = self._shorten(summ["extract"], 360)
                return {
                    "stop_name": stop.get("name"),
                    "bullets": [extract],
                    "sources": [{"id": 1, "title": summ.get("title") or title, "url": summ.get("url")}],
                    "lang": lang,
                }
            except Exception:
                continue
        return None

    async def _build_web_context(self, city: str, stops: List[dict]) -> dict:
        """
        Собираем факты по первым 5 остановкам (чтобы не долбить сеть).
        Параллелим запросы умеренно.
        """
        sample = stops[:5] if isinstance(stops, list) else []
        tasks = [self._facts_for_stop(s) for s in sample]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        per_stop: List[dict] = []
        for r in results:
            if isinstance(r, dict) and r.get("bullets"):
                per_stop.append(r)

        return {"per_stop": per_stop, "city": city}


# -------- helpers ----------
def _safe_json_loads(payload: str, default: ConversationResponse) -> ConversationResponse:
    try:
        parsed = json.loads(payload)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    return default
