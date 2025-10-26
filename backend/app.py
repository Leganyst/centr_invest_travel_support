"""FastAPI application for the cultural route planner MVP."""

from __future__ import annotations

from datetime import date as DateType, datetime
from pathlib import Path
from typing import Any, List, Tuple

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import ics_utils
import route_logic
import seed_loader
from config import Settings
from llm_client import LLMClient
from tags_vocab import normalize_tags
from two_gis_client import fetch_places_by_radius, is_enabled as dgis_is_enabled

DEFAULT_CITY = "Ростов-на-Дону"
TAG_QUERY_MAP = {
    "history": "исторические места",
    "museum": "музей",
    "art": "галерея",
    "architecture": "архитектура",
    "park": "парк",
    "walk": "набережная",
    "food": "рестораны",
    "coffee": "кофейни",
    "family": "семейные развлечения",
}

app = FastAPI(title="Rostov Day Trip Planner")

settings = Settings.load()
llm_client = LLMClient(settings)
SEED_PLACES = seed_loader.load_seed()
FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"


@app.on_event("startup")
async def generate_frontend_config() -> None:
    """Ensure frontend/config.js is regenerated from the latest .env."""
    try:
        from scripts.gen_frontend_config import main as build_config
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[WARN] Frontend config import failed: {exc}")
        return

    try:
        build_config()
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[WARN] Frontend config generation failed: {exc}")


if FRONTEND_DIR.exists():
    app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")
else:  # pragma: no cover - optional logging
    print(f"[WARN] Frontend directory missing: {FRONTEND_DIR}")


@app.get("/", include_in_schema=False)
def serve_frontend() -> FileResponse:
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Frontend UI is not available")
    return FileResponse(index_path)


class Geo(BaseModel):
    """Геопозиция пользователя, используемая для поиска и старта маршрута."""

    lat: float = Field(description="Широта пользователя в десятичных градусах")
    lon: float = Field(description="Долгота пользователя в десятичных градусах")
    accuracy_m: int | None = Field(
        default=None,
        description="Погрешность GPS в метрах (используется только для отображения)",
    )


class PlanRequest(BaseModel):
    """Запрос на построение однодневного культурного маршрута."""

    city: str | None = Field(
        default=DEFAULT_CITY,
        description="Город по умолчанию, если геопозиция не передана",
    )
    date: DateType = Field(description="Дата поездки, ISO формат YYYY-MM-DD")
    tags: List[str] = Field(
        default_factory=list,
        description="Интересы пользователя. Мапятся на канонические теги через словарь",
    )
    budget: str | None = Field(
        default=None,
        description="Бюджет (low/medium/high). Пока не влияет на алгоритм, но передаётся в LLM",
    )
    pace: str | None = Field(
        default=None,
        description="Темп прогулки (relaxed/normal/fast). Пока используется только для LLM",
    )
    user_location: Geo | None = Field(
        default=None,
        description="Если указано — поиск и маршрут стартуют с этой точки",
    )
    radius_m: int | None = Field(
        default=None,
        ge=100,
        le=2000,
        description="Радиус поиска объектов 2ГИС в метрах (ограничен демо-ключом 2000)",
    )


class Stop(BaseModel):
    """Остановка маршрута с вычисленным временем посещения."""

    name: str = Field(description="Название места")
    lat: float = Field(description="Широта точки")
    lon: float = Field(description="Долгота точки")
    arrive: str = Field(description="Время прибытия (ISO8601)")
    leave: str = Field(description="Время окончания посещения (ISO8601)")
    tags: List[str] = Field(default_factory=list, description="Канонические теги места")


class PlanResponse(BaseModel):
    """Ответ с финальным маршрутом и календарием."""

    stops: List[Stop] = Field(description="Последовательность остановок на день")
    total_time: str = Field(description="Человекочитаемая длительность всего маршрута")
    total_minutes: int = Field(description="Продолжительность маршрута в минутах")
    ics: str = Field(
        description="Содержимое ICS-файла (Europe/Moscow, с описанием остановок)"
    )


class ConversationRequest(BaseModel):
    known_prefs: dict[str, Any] = Field(default_factory=dict)


class ExplainRequest(BaseModel):
    prefs: dict[str, Any]
    stops: List[Stop]


@app.get(
    "/healthz",
    summary="Проверка состояния сервиса",
    description="Простой health-check без дополнительных проверок",
)
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.get(
    "/places",
    response_model=List[seed_loader.Place],
    summary="Справочник мест",
    description=(
        "Запрашивает топ объектов через 2ГИС (или сиды, если ключа нет). "
        "Используется для отладки и ручных проверок. Радиус ограничен 2 км в демо-ключе."
    ),
)
def list_places(
    q: str | None = None,
    lat: float | None = None,
    lon: float | None = None,
    radius: int = Query(2000, ge=100, le=2000),
    limit: int = Query(20, ge=1, le=100),
) -> List[seed_loader.Place]:
    point = _point_for_search(lat, lon)
    query = q or settings.dgis_default_query
    results: List[seed_loader.Place] = []

    if dgis_is_enabled(settings):
        try:
            results = fetch_places_by_radius(
                settings,
                point,
                radius,
                query,
                location=point,
            )
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[WARN] 2GIS /places failed: {exc}")

    if not results:
        results = SEED_PLACES

    return results[:limit]


def _build_plan(payload: PlanRequest) -> tuple[PlanResponse, str]:
    """Generalised планер, используемый JSON- и ICS-эндпоинтами."""

    user_tags = normalize_tags(payload.tags)
    radius_m = _clamp_radius(payload.radius_m)
    start_location = (
        (payload.user_location.lat, payload.user_location.lon)
        if payload.user_location
        else None
    )
    search_point = _point_for_search(
        payload.user_location.lat if payload.user_location else None,
        payload.user_location.lon if payload.user_location else None,
        city=payload.city or DEFAULT_CITY,
    )

    query = _query_from_tags(user_tags) or settings.dgis_default_query
    dynamic_places: List[seed_loader.Place] = []
    if dgis_is_enabled(settings):
        try:
            dynamic_places = fetch_places_by_radius(
                settings,
                search_point,
                radius_m,
                query,
                location=search_point if payload.user_location else None,
            )
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[WARN] 2GIS fetch failed: {exc}")

    combined_places = (
        _merge_places(dynamic_places, SEED_PLACES)
        if dynamic_places
        else SEED_PLACES
    )

    planning_date = datetime.combine(payload.date, datetime.min.time())
    route = route_logic.build_route(
        payload.city or DEFAULT_CITY,
        planning_date,
        combined_places,
        user_tags,
        start_location=start_location,
    )

    description = (
        f"Маршрут на {payload.date.isoformat()} — {len(route['stops'])} остановок."
    )
    ics_payload = ics_utils.make_ics(
        route["stops"],
        title=f"Маршрут: {payload.city or DEFAULT_CITY}",
        description=description,
    )

    plan = PlanResponse(
        stops=[Stop(**stop) for stop in route["stops"]],
        total_time=route["total_time_human"],
        total_minutes=route["total_minutes"],
        ics=ics_payload,
    )
    return plan, ics_payload


@app.post(
    "/plan",
    response_model=PlanResponse,
    summary="Построение однодневного маршрута",
    description=(
        "1) Определяем точку старта (геопозиция пользователя или центр города).\n"
        "2) Запрашиваем объекты 2ГИС по радиусу (кэшируется на сутки).\n"
        "3) Объединяем данные с сидовым набором и нормализуем теги.\n"
        "4) Выбираем до 7 релевантных мест по тегам, упорядочиваем ближайшим соседом,"
        " добавляя дорогу (haversine) и длительность посещения по типу места.\n"
        "5) Возвращаем последовательность остановок, суммарное время и ICS для календаря."
    ),
)
def plan_trip(payload: PlanRequest) -> PlanResponse:
    plan, _ = _build_plan(payload)
    return plan


@app.post(
    "/plan/ics",
    summary="Построение маршрута с выгрузкой ICS",
    description=(
        "Повторяет логику `/plan`, но возвращает готовый файл `.ics` с таймзоной"
        " (Europe/Moscow) и описанием остановок."
    ),
    response_class=Response,
)
def plan_trip_ics(payload: PlanRequest) -> Response:
    _, ics_payload = _build_plan(payload)
    filename = f"route_{payload.date.isoformat()}.ics"
    return Response(
        content=ics_payload,
        media_type="text/calendar",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post(
    "/llm/next",
    summary="Следующий шаг диалога с LLM",
    description=(
        "Возвращает либо следующий вопрос (mode=ask), либо готовые предпочтения (mode=ready). "
        "При отсутствии LLM работает fallback: дата → теги → бюджет → темп."
    ),
)
async def llm_next_step(request: ConversationRequest) -> dict[str, Any]:
    """Return next question or ready preferences for the conversational flow."""
    response = await llm_client.next_step(request.known_prefs)
    return response


@app.post(
    "/llm/explain",
    summary="Пояснение маршрута через LLM",
    description=(
        "Передайте prefs и stops из /plan — сервис вернёт короткое объяснение."
        " Без LLM используется шаблонная подсказка."
    ),
)
async def llm_explain(request: ExplainRequest) -> dict[str, str]:
    """Generate a short explanation for an already built route."""
    text = await llm_client.explain_route(request.prefs, [stop.dict() for stop in request.stops])
    return {"text": text}


def _point_for_search(lat: float | None, lon: float | None, *, city: str = DEFAULT_CITY) -> Tuple[float, float]:
    if lat is not None and lon is not None:
        return (lon, lat)
    center = route_logic.CITY_CENTERS.get(city, route_logic.CITY_CENTERS[DEFAULT_CITY])
    return (center[1], center[0])


def _merge_places(primary: List[seed_loader.Place], secondary: List[seed_loader.Place]) -> List[seed_loader.Place]:
    combined: dict[str, seed_loader.Place] = {}
    for place in primary + secondary:
        place_id = place.get("id") or f"{place['lat']},{place['lon']}"
        if place_id not in combined:
            combined[place_id] = place
    return list(combined.values())


def _clamp_radius(radius_m: int | None) -> int:
    if radius_m is None:
        return 2000
    return max(100, min(radius_m, 2000))


def _query_from_tags(tags: List[str]) -> str:
    mapped = [TAG_QUERY_MAP.get(tag) for tag in tags if TAG_QUERY_MAP.get(tag)]
    if mapped:
        return ", ".join(dict.fromkeys(mapped))
    if tags:
        return ", ".join(tags)
    return ""
