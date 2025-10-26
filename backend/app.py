"""FastAPI application for the cultural route planner MVP."""

from __future__ import annotations

from datetime import date as DateType, datetime, timedelta
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
from tags_vocab import allowed_tags, normalize_tags
from two_gis_client import fetch_specs_in_region
from route_logic import build_route
from tag_queries import plan_queries
import logging
import os




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


log = logging.getLogger("boot")

def _mask(v: str | None) -> str | None:
    if not v:
        return v
    v = str(v)
    if len(v) <= 6:
        return "***"
    return f"{v[:3]}***{v[-3:]} (len={len(v)})"



@app.on_event("startup")
async def generate_frontend_config() -> None:
    """Ensure frontend/config.js is regenerated from the latest .env."""
    try:
        from scripts.gen_frontend_config import main as build_config
        log.info("DGIS_API_KEY=%s", _mask(os.environ.get("DGIS_API_KEY")))
        log.info("settings.dgis_api_key=%s", _mask(getattr(settings, "dgis_api_key", "")))

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
    description: str | None = Field(default=None, description="Короткое описание места")


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


@app.get("/tags")
def get_tags():
    return {"tags": allowed_tags()}

@app.post("/normalize_tags")
def post_normalize(payload: dict):
    raw = payload.get("tags", [])
    return {"tags": normalize_tags(raw)}

@app.get(
    "/places",
    response_model=List[seed_loader.Place],
    summary="Справочник мест рядом с пользователем",
    description=(
        "Возвращает список ближайших объектов по данным 2ГИС. "
        "Можно фильтровать по текстовому запросу и тегам. "
        "Если внешний API недоступен, используется сидовый набор."
    ),
)
def list_places(
    q: str | None = None,
    lat: float | None = None,
    lon: float | None = None,
    radius: int = Query(1500, ge=100, le=2000),
    limit: int = Query(20, ge=1, le=100),
    tags: List[str] = Query(default_factory=list),
) -> List[seed_loader.Place]:
    """Return nearby places sorted by distance from the provided point."""
    normalized_tags = normalize_tags(tags)
    search_lat, search_lon = _starting_point(lat, lon, city=DEFAULT_CITY)
    search_point = (search_lon, search_lat)

    candidates: List[seed_loader.Place] = []
    if dgis_is_enabled(settings):
        queries = _build_query_sequence(q, normalized_tags)
        candidates = _collect_places_from_2gis(
            queries,
            search_point,
            _clamp_radius(radius),
            include_location=lat is not None and lon is not None,
        )
    else:
        candidates = SEED_PLACES.copy()

    if not candidates:
        candidates = SEED_PLACES.copy()

    if lat is not None and lon is not None:
        candidates.sort(
            key=lambda place: route_logic.haversine_km(lat, lon, place["lat"], place["lon"])
        )

    return candidates[:limit]


def _build_plan(payload: PlanRequest) -> tuple[PlanResponse, str]:
    """Build a pedestrian-friendly route near the user using 2GIS data."""

    normalized_tags = normalize_tags(payload.tags)
    search_city = payload.city or DEFAULT_CITY
    start_lat, start_lon = _starting_point(
        payload.user_location.lat if payload.user_location else None,
        payload.user_location.lon if payload.user_location else None,
        city=search_city,
    )
    search_point = (start_lon, start_lat)

    radius_m = _clamp_radius(payload.radius_m)
    dynamic_places: List[seed_loader.Place] = []

    if dgis_is_enabled(settings):
        queries = _build_query_sequence(None, normalized_tags)
        # ensure default query present
        dynamic_places = _collect_places_from_2gis(
            queries,
            search_point,
            radius_m,
            include_location=payload.user_location is not None,
        )

    if not dynamic_places:
        dynamic_places = SEED_PLACES.copy()

    selected_places = _select_nearest_places(
        dynamic_places,
        start_lat,
        start_lon,
        limit=8,
    )

    ordered_places = route_logic.order_by_nearest(start_lat, start_lon, selected_places.copy())

    stops, total_minutes = _build_schedule(
        ordered_places,
        start_lat,
        start_lon,
        payload.date,
    )

    description = f"Маршрут на {payload.date.isoformat()} — {len(stops)} остановок."
    ics_payload = ics_utils.make_ics(
        stops,
        title=f"Маршрут: {search_city}",
        description=description,
    )

    plan = PlanResponse(
        stops=[Stop(**stop) for stop in stops],
        total_time=route_logic._format_duration(total_minutes),
        total_minutes=total_minutes,
        ics=ics_payload,
    )
    return plan, ics_payload


@app.post(
    "/plan",
    response_model=PlanResponse,
    summary="Построение однодневного маршрута",
    description=(
        "1) Определяем точку старта: геолокация пользователя или центр выбранного города.\n"
        "2) Запрашиваем ближайшие объекты через 2ГИС с учётом интересов.\n"
        "3) Сортируем до 8 точек по удалённости и строим пешеходный маршрут ближайшим соседом.\n"
        "4) Возвращаем последовательность остановок с прогнозом времени и готовым ICS."
    ),
)
def plan_trip(payload: dict) -> dict:
    date_str = payload.get("date")
    date_value = datetime.fromisoformat(date_str) if date_str else datetime.now()

    # 1) Координаты пользователя (lon, lat!)
    user_loc = payload.get("user_location") or {}
    user_lon = float(user_loc.get("lon"))
    user_lat = float(user_loc.get("lat"))
    user_point = (user_lon, user_lat)

    # 2) Канонические теги
    requested_tags = normalize_tags(payload.get("tags") or [])

    # 3) План запросов под канонические теги
    specs = plan_queries(requested_tags)

    # 4) Вся область + сортировка по близости к пользователю
    places = fetch_specs_in_region(settings, user_point, specs, region_name="Ростовская область")

    # 5) Маршрут
    plan = build_route(
        city=payload.get("city") or "Ростов-на-Дону",   # чисто для отображения
        date_value=date_value,
        places=places,
        tags=requested_tags,
        start_location=(user_lat, user_lon),           # NB: ваша build_route ждёт (lat, lon)
    )
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


def _starting_point(
    lat: float | None,
    lon: float | None,
    *,
    city: str = DEFAULT_CITY,
) -> Tuple[float, float]:
    if lat is not None and lon is not None:
        return lat, lon
    center = route_logic.CITY_CENTERS.get(city, route_logic.CITY_CENTERS[DEFAULT_CITY])
    return center[0], center[1]


def _build_query_sequence(user_query: str | None, tags: List[str]) -> List[str]:
    candidates: List[str] = []
    if user_query:
        candidates.append(user_query)
    mapped = [TAG_QUERY_MAP.get(tag) for tag in tags if TAG_QUERY_MAP.get(tag)]
    candidates.extend(mapped)
    tag_query = _query_from_tags(tags)
    if tag_query:
        candidates.append(tag_query)
    candidates.append(settings.dgis_default_query)
    # remove duplicates while preserving order
    seen: set[str] = set()
    unique: List[str] = []
    for item in candidates:
        if not item:
            continue
        if item not in seen:
            seen.add(item)
            unique.append(item)
    return unique


def _collect_places_from_2gis(
    queries: List[str],
    point: Tuple[float, float],
    radius_m: int,
    *,
    include_location: bool,
) -> List[seed_loader.Place]:
    collected: List[seed_loader.Place] = []
    seen: set[str] = set()
    for query in queries:
        try:
            batch = fetch_places_by_radius(
                settings,
                point,
                radius_m,
                query,
                location=point if include_location else None,
            )
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[WARN] 2GIS fetch failed for query '{query}': {exc}")
            continue
        for place in batch:
            place_id = place.get("id") or f"{place['lat']},{place['lon']}"
            if place_id in seen:
                continue
            seen.add(place_id)
            collected.append(place)
        if len(collected) >= 40:
            break
    return collected


def _select_nearest_places(
    places: List[seed_loader.Place],
    start_lat: float,
    start_lon: float,
    *,
    limit: int,
) -> List[seed_loader.Place]:
    if not places:
        return []
    sorted_places = sorted(
        places,
        key=lambda place: route_logic.haversine_km(
            start_lat,
            start_lon,
            place["lat"],
            place["lon"],
        ),
    )
    return sorted_places[:limit]


def _build_schedule(
    places: List[seed_loader.Place],
    start_lat: float,
    start_lon: float,
    trip_date: DateType,
) -> Tuple[List[dict[str, Any]], int]:
    current_time = datetime.combine(trip_date, route_logic.DEFAULT_START_TIME)
    previous_lat, previous_lon = start_lat, start_lon
    total_minutes = 0
    stops: List[dict[str, Any]] = []

    for place in places:
        distance_km = route_logic.haversine_km(
            previous_lat,
            previous_lon,
            place["lat"],
            place["lon"],
        )
        travel_minutes = max(
            route_logic.MIN_TRAVEL_MINUTES,
            int(distance_km * route_logic.TRAVEL_MINUTES_PER_KM),
        )
        current_time += timedelta(minutes=travel_minutes)
        arrive_time = current_time

        visit_minutes = route_logic._duration_for_place(place)
        leave_time = arrive_time + timedelta(minutes=visit_minutes)

        stops.append(
            {
                "name": place["name"],
                "lat": place["lat"],
                "lon": place["lon"],
                "arrive": arrive_time.isoformat(),
                "leave": leave_time.isoformat(),
                "tags": place.get("tags", []),
            }
        )

        total_minutes += travel_minutes + visit_minutes
        current_time = leave_time
        previous_lat, previous_lon = place["lat"], place["lon"]

    return stops, total_minutes
