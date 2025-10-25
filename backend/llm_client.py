"""Lightweight LLM integration with graceful fallbacks."""

from __future__ import annotations

import json
from typing import Any, Dict

import httpx

from config import Settings
from tags_vocab import allowed_tags, normalize_tags

ConversationResponse = Dict[str, Any]


class LLMClient:
    """Wrapper around a chat-completions style API."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def is_enabled(self) -> bool:
        return self._settings.llm_enabled

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
        if "tags" in prefs:
            prefs = {**prefs, "tags": normalize_tags(prefs.get("tags", []))}

        if self.is_enabled():
            try:
                return await self._call_explain_api(prefs, stops)
            except Exception as exc:  # pragma: no cover - network guardrail
                return self._fallback_explain(prefs, stops, error=str(exc))
        return self._fallback_explain(prefs, stops)

    async def _call_conversation_api(self, known_prefs: dict[str, Any]) -> ConversationResponse:
        messages = [
            {
                "role": "system",
                "content": (
                    "Ты ассистент, который собирает параметры для планирования "
                    "однодневного культурного маршрута по Ростову-на-Дону. "
                    "Отвечай строго валидным JSON без пояснений. "
                    "Форматы ответов:\n"
                    "ASK: {\"mode\":\"ask\",\"question\":\"...\",\"field\":\"...\"," \
                    "\"input\":\"date|single|multiselect\",\"options\":[...]}\n"
                    "READY: {\"mode\":\"ready\",\"prefs\":{\"date\":\"YYYY-MM-DD\"," \
                    "\"city\":\"...\",\"tags\":[allowed],\"budget\":\"low|medium|high\"," \
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
        self, prefs: dict[str, Any], stops: list[dict[str, Any]]
    ) -> str:
        messages = [
            {
                "role": "system",
                "content": (
                    "Ты объясняешь пользователю маршрут. "
                    "Ответ на русском, 2-3 предложения, без JSON."
                ),
            },
            {
                "role": "user",
                "content": json.dumps({"prefs": prefs, "stops": stops}, ensure_ascii=False),
            },
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
        return " ".join(parts)


def _safe_json_loads(payload: str, default: ConversationResponse) -> ConversationResponse:
    try:
        parsed = json.loads(payload)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    return default
