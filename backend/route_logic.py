"""Naive routing heuristics for the hackathon MVP."""

from __future__ import annotations

from datetime import datetime, time, timedelta
from math import asin, cos, radians, sin, sqrt
from typing import Iterable, List, Tuple

from seed_loader import Place

CITY_CENTERS = {
    "Ростов-на-Дону": (47.222078, 39.720349),
    "Таганрог": (47.2096, 38.9358),
    "Азов": (47.1121, 39.4231),
}

TRAVEL_MINUTES_PER_KM = 4
MIN_TRAVEL_MINUTES = 8
DEFAULT_START_TIME = time(10, 0)
MAX_STOPS = 7


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Compute the distance between two coordinates in kilometers."""
    radius = 6371.0
    d_lat = radians(lat2 - lat1)
    d_lon = radians(lon2 - lon1)
    a = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
    c = 2 * asin(sqrt(a))
    return radius * c


def _duration_for_place(place: Place) -> int:
    tags = set(place.get("tags", []))
    if tags & {"food", "coffee"}:
        return 45
    if tags & {"museum", "history", "gallery"}:
        return 75
    if tags & {"park", "walk", "embankment", "nature"}:
        return 60
    return 50


def _score_place(place: Place, requested_tags: list[str]) -> float:
    if not requested_tags:
        return 1.0
    overlap = len(set(place.get("tags", [])) & set(requested_tags))
    return overlap / max(len(requested_tags), 1)


def pick_candidates(places: Iterable[Place], requested_tags: list[str]) -> List[Place]:
    scored = sorted(
        places,
        key=lambda p: _score_place(p, requested_tags),
        reverse=True,
    )
    filtered = [place for place in scored if _score_place(place, requested_tags) > 0]
    if not filtered:
        filtered = scored
    return filtered[:MAX_STOPS]


def order_by_nearest(start_lat: float, start_lon: float, places: List[Place]) -> List[Place]:
    ordered: List[Place] = []
    remaining = places.copy()
    current_lat, current_lon = start_lat, start_lon
    while remaining:
        next_place = min(
            remaining,
            key=lambda p: haversine_km(current_lat, current_lon, p["lat"], p["lon"]),
        )
        ordered.append(next_place)
        current_lat, current_lon = next_place["lat"], next_place["lon"]
        remaining.remove(next_place)
    return ordered


def build_route(
    city: str,
    date_value: datetime,
    places: Iterable[Place],
    tags: list[str],
    start_location: Tuple[float, float] | None = None,
) -> dict:
    """Build a simple day route starting from city center or provided location."""
    city_center = CITY_CENTERS.get(city, CITY_CENTERS["Ростов-на-Дону"])
    start_lat, start_lon = start_location or city_center

    selected = pick_candidates(list(places), tags)
    ordered = order_by_nearest(start_lat, start_lon, selected)

    current_time = datetime.combine(date_value.date(), DEFAULT_START_TIME)
    current_lat, current_lon = start_lat, start_lon

    stops = []
    total_minutes = 0

    for place in ordered:
        distance_km = haversine_km(current_lat, current_lon, place["lat"], place["lon"])
        travel_minutes = max(MIN_TRAVEL_MINUTES, int(distance_km * TRAVEL_MINUTES_PER_KM))
        current_time += timedelta(minutes=travel_minutes)
        arrive_time = current_time

        duration = _duration_for_place(place)
        leave_time = arrive_time + timedelta(minutes=duration)

        stops.append(
            {
                "name": place["name"],
                "lat": place["lat"],
                "lon": place["lon"],
                "description": place.get("description"),
                "arrive": arrive_time.isoformat(),
                "leave": leave_time.isoformat(),
                "tags": place.get("tags", []),
            }
        )

        total_minutes += travel_minutes + duration
        current_time = leave_time
        current_lat, current_lon = place["lat"], place["lon"]

    return {
        "stops": stops,
        "total_minutes": total_minutes,
        "total_time_human": _format_duration(total_minutes),
    }


def _format_duration(total_minutes: int) -> str:
    hours, minutes = divmod(total_minutes, 60)
    if hours and minutes:
        return f"{hours}ч {minutes}мин"
    if hours:
        return f"{hours}ч"
    return f"{minutes}мин"
