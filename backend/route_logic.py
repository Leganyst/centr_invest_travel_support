from __future__ import annotations
from datetime import datetime, time, timedelta
from math import asin, cos, radians, sin, sqrt
from typing import Iterable, List, Tuple, Dict, Any, Optional
from ics_utils import make_ics

from seed_loader import Place

# Фолбэки только на случай, если не передали start_location
CITY_CENTERS = {
    "Ростов-на-Дону": (47.222078, 39.720349),
    "Таганрог": (47.2096, 38.9358),
    "Азов": (47.1121, 39.4231),
}

TRAVEL_MINUTES_PER_KM = 4
MIN_TRAVEL_MINUTES = 8
DEFAULT_START_TIME = time(10, 0)
MAX_STOPS = 7

# Кандидаты и скоринг
CANDIDATE_CLUSTER_M = 150
CANDIDATE_POOL_MULTIPLIER = 3
W_INTEREST, W_PROXIMITY, W_QUALITY = 0.55, 0.30, 0.15

# Пешком/транспорт
WALK_KM_THRESHOLD = 1.2
WALK_MIN_PER_KM = 12
DRIVE_MIN_PER_KM = 3

# Ланч/кофе
LUNCH_INSERT_AFTER_HOURS = 3.5
FOOD_TAGS = {"food", "coffee", "restaurant", "cafe", "бар", "еда", "кофе"}

# ---- Гео и длительности ----

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    d_lat = radians(lat2 - lat1)
    d_lon = radians(lon2 - lon1)
    a = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
    c = 2 * asin(sqrt(a))
    return radius * c

def _duration_for_place(place: Place) -> int:
    tags = set(place.get("tags", []))
    if tags & FOOD_TAGS:
        return 45
    if tags & {"museum", "history", "gallery"}:
        return 75
    if tags & {"park", "walk", "embankment", "nature"}:
        return 60
    return 50

def _travel_minutes(distance_km: float) -> int:
    if distance_km <= WALK_KM_THRESHOLD:
        est = distance_km * WALK_MIN_PER_KM
    else:
        est = distance_km * DRIVE_MIN_PER_KM
    return max(MIN_TRAVEL_MINUTES, int(round(est)))

# ---- Скора и отбор ----

def _interest_score(place: Place, requested_tags: list[str]) -> float:
    if not requested_tags:
        return 1.0
    p_tags = set(place.get("tags", []))
    r_tags = set(requested_tags)
    if not r_tags:
        return 0.0
    return len(p_tags & r_tags) / len(r_tags)

def _proximity_score(distance_km: float) -> float:
    return 1.0 / (1.0 + distance_km)

def _quality_score(place: Place) -> float:
    rating = float(place.get("rating", 0) or 0)
    reviews = int(place.get("reviews_count", 0) or 0)
    base = rating / 5.0 if rating else 0.0
    boost = min(1.0, (reviews / 200.0)) * 0.2
    return max(0.0, min(1.0, base + boost))

def _score_place(place: Place, requested_tags: list[str], origin: Optional[Tuple[float, float]]) -> float:
    d = haversine_km(origin[0], origin[1], place["lat"], place["lon"]) if origin else 0.0
    s_interest = _interest_score(place, requested_tags)
    s_prox = _proximity_score(d) if origin else 0.5
    s_quality = _quality_score(place)
    return (W_INTEREST * s_interest) + (W_PROXIMITY * s_prox) + (W_QUALITY * s_quality)

def _cluster_key(lat: float, lon: float) -> Tuple[int, int]:
    return (int(lat / 0.00135), int(lon / 0.00135))  # ~150 м

def pick_candidates(
    places: Iterable[Place],
    requested_tags: list[str],
    start_location: Optional[Tuple[float, float]] = None,
) -> List[Place]:
    items = list(places)
    if not items:
        return []

    scored = sorted(
        items,
        key=lambda p: _score_place(p, requested_tags, start_location),
        reverse=True,
    )
    pool_size = max(MAX_STOPS * CANDIDATE_POOL_MULTIPLIER, MAX_STOPS)
    pool = scored[:pool_size]

    # покрытие интересов
    coverage: Dict[str, Place] = {}
    r_tags = list(dict.fromkeys(requested_tags))
    for tag in r_tags:
        tagged = [p for p in pool if tag in p.get("tags", [])]
        if tagged:
            best = max(tagged, key=lambda p: _score_place(p, requested_tags, start_location))
            coverage[tag] = best

    # анти-дубликаты
    picked: Dict[Tuple[int, int], Place] = {}
    for p in pool:
        key = _cluster_key(p["lat"], p["lon"])
        if key not in picked:
            picked[key] = p
        else:
            if _score_place(p, requested_tags, start_location) > _score_place(picked[key], requested_tags, start_location):
                picked[key] = p

    unique_pool = list(picked.values())

    result: List[Place] = list({id(v): v for v in coverage.values()}.values())
    remaining = [p for p in unique_pool if p not in result]
    remaining.sort(key=lambda p: _score_place(p, requested_tags, start_location), reverse=True)

    for p in remaining:
        if len(result) >= MAX_STOPS:
            break
        result.append(p)

    return result[:MAX_STOPS]

# ---- Упорядочивание маршрута ----

def _route_len(seq: List[Place], s_lat: float, s_lon: float) -> float:
    length = 0.0
    c_lat, c_lon = s_lat, s_lon
    for p in seq:
        length += haversine_km(c_lat, c_lon, p["lat"], p["lon"])
        c_lat, c_lon = p["lat"], p["lon"]
    return length

def _nearest_neighbor(start_lat: float, start_lon: float, places: List[Place]) -> List[Place]:
    ordered: List[Place] = []
    remaining = places.copy()
    cur_lat, cur_lon = start_lat, start_lon
    while remaining:
        nxt = min(remaining, key=lambda p: haversine_km(cur_lat, cur_lon, p["lat"], p["lon"]))
        ordered.append(nxt)
        cur_lat, cur_lon = nxt["lat"], nxt["lon"]
        remaining.remove(nxt)
    return ordered

def _two_opt(start_lat: float, start_lon: float, route: List[Place]) -> List[Place]:
    best = route
    best_len = _route_len(best, start_lat, start_lon)
    n = len(best)
    improved = True
    while improved:
        improved = False
        for i in range(0, n - 2):
            for j in range(i + 2, n):
                new_seq = best[:i + 1] + best[i + 1:j + 1][::-1] + best[j + 1:]
                new_len = _route_len(new_seq, start_lat, start_lon)
                if new_len + 1e-9 < best_len:
                    best, best_len = new_seq, new_len
                    improved = True
    return best

def _or_opt(start_lat: float, start_lon: float, route: List[Place]) -> List[Place]:
    best = route[:]
    best_len = _route_len(best, start_lat, start_lon)
    n = len(best)
    for i in range(n):
        node = best[i]
        rest = best[:i] + best[i+1:]
        for j in range(len(rest) + 1):
            cand = rest[:j] + [node] + rest[j:]
            cand_len = _route_len(cand, start_lat, start_lon)
            if cand_len + 1e-9 < best_len:
                best, best_len = cand, cand_len
    return best

def order_by_nearest(start_lat: float, start_lon: float, places: List[Place]) -> List[Place]:
    if not places:
        return []
    nn = _nearest_neighbor(start_lat, start_lon, places)
    t2 = _two_opt(start_lat, start_lon, nn)
    t3 = _or_opt(start_lat, start_lon, t2)
    return t3

# ---- Часы работы (мягко, если есть) ----

def _parse_hours(place: Place) -> Optional[List[Tuple[time, time]]]:
    slots = place.get("hours_today") or (place.get("work_time") or {}).get("today")
    if not slots:
        return None
    parsed: List[Tuple[time, time]] = []
    for s in slots:
        try:
            f = s.get("from"); t = s.get("to")
            fh, fm = map(int, (f or "").split(":"))
            th, tm = map(int, (t or "").split(":"))
            parsed.append((time(fh, fm), time(th, tm)))
        except Exception:
            continue
    return parsed or None

def _align_to_opening(cur_dt: datetime, slots: Optional[List[Tuple[time, time]]]) -> datetime:
    if not slots:
        return cur_dt
    for f, t in slots:
        start = cur_dt.replace(hour=f.hour, minute=f.minute, second=0, microsecond=0)
        end = cur_dt.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
        if cur_dt <= end:
            return max(cur_dt, start)
    return cur_dt

# ---- Вставка «перекуса» (опционально) ----

def _maybe_insert_food(start_lat: float, start_lon: float, ordered: List[Place], all_places: List[Place]) -> List[Place]:
    if not ordered:
        return ordered
    has_food = any(set(p.get("tags", [])) & FOOD_TAGS for p in ordered)
    if has_food:
        return ordered
    mid_idx = len(ordered) // 2
    anchor = ordered[mid_idx]
    candidates = [p for p in all_places if set(p.get("tags", [])) & FOOD_TAGS and p not in ordered]
    if not candidates:
        return ordered
    best = min(candidates, key=lambda p: haversine_km(anchor["lat"], anchor["lon"], p["lat"], p["lon"]))
    best_route, best_len = ordered, _route_len(ordered, start_lat, start_lon)
    for j in range(len(ordered) + 1):
        cand = ordered[:j] + [best] + ordered[j:]
        l = _route_len(cand, start_lat, start_lon)
        if l < best_len:
            best_route, best_len = cand, l
    return best_route

# ---- Сборка маршрута ----

def build_route(
    city: str,
    date_value: datetime,
    places: Iterable[Place],
    tags: list[str],
    start_location: Tuple[float, float] | None = None,   # ПЕРЕДАВАЙ сюда координаты пользователя!
    *,
    day_end: time | None = time(20, 0),
) -> dict:
    """
    Маршрут дня по интересам пользователя:
    - покрытие интересов, диверсификация;
    - компактный порядок (NN→2-opt→or-opt);
    - мягкие окна работы (если есть);
    - вставка «перекуса» при длинном дне.
    """
    city_center = CITY_CENTERS.get(city, CITY_CENTERS["Ростов-на-Дону"])
    start_lat, start_lon = start_location or city_center

    items = list(places)
    # дедуп по координатам+имени
    seen = set()
    dedup: List[Place] = []
    for p in items:
        key = (round(p["lat"], 6), round(p["lon"], 6), p.get("name"))
        if key in seen:
            continue
        seen.add(key)
        dedup.append(p)

    selected = pick_candidates(dedup, tags, (start_lat, start_lon))
    ordered = order_by_nearest(start_lat, start_lon, selected)
    if len(ordered) >= 4:
        ordered = _maybe_insert_food(start_lat, start_lon, ordered, dedup)[:MAX_STOPS]

    current_time = datetime.combine(date_value.date(), DEFAULT_START_TIME)
    hard_stop = datetime.combine(date_value.date(), day_end) if isinstance(day_end, time) else None

    cur_lat, cur_lon = start_lat, start_lon
    stops = []
    total_minutes = 0
    last_lunch_insert = None

    for idx, place in enumerate(ordered):
        distance_km = haversine_km(cur_lat, cur_lon, place["lat"], place["lon"])
        travel_minutes = _travel_minutes(distance_km)
        arrive_time = current_time + timedelta(minutes=travel_minutes)

        slots = _parse_hours(place)
        arrive_time = _align_to_opening(arrive_time, slots)

        duration = _duration_for_place(place)

        hours_since_start = (arrive_time - datetime.combine(date_value.date(), DEFAULT_START_TIME)).total_seconds() / 3600
        if last_lunch_insert is None and hours_since_start >= LUNCH_INSERT_AFTER_HOURS:
            if not (set(place.get("tags", [])) & FOOD_TAGS):
                arrive_time += timedelta(minutes=10)
            last_lunch_insert = idx

        leave_time = arrive_time + timedelta(minutes=duration)

        if hard_stop and leave_time > hard_stop:
            break

        stops.append(
            {
                "name": place["name"],
                "lat": place["lat"],
                "lon": place["lon"],
                "arrive": arrive_time.isoformat(),
                "leave": leave_time.isoformat(),
                "tags": place.get("tags", []),
                "distance_km_from_prev": round(distance_km, 2),
                "travel_min_from_prev": travel_minutes,
            }
        )

        total_minutes += travel_minutes + duration
        current_time = leave_time
        cur_lat, cur_lon = place["lat"], place["lon"]
        
    total_time_str = _format_duration(total_minutes)

    # Формируем ICS через штатный клиент
    ics_payload = make_ics(
        stops,
        title=f"Маршрут: {city} {date_value:%Y-%m-%d}",
        description=(", ".join(tags) if tags else None),
        tzid="Europe/Moscow",  # Ростовская область = МСК (UTC+3)
    )

    return {
        "stops": stops,
        "total_minutes": total_minutes,
        "total_time": total_time_str,        # <-- требует модель ответа
        "total_time_human": total_time_str,  # <-- оставим для обратной совместимости фронта
        "ics": ics_payload,                  # <-- требует модель ответа
    }
    
def _format_duration(total_minutes: int) -> str:
    hours, minutes = divmod(total_minutes, 60)
    if hours and minutes:
        return f"{hours}ч {minutes}мин"
    if hours:
        return f"{hours}ч"
    return f"{minutes}мин"

