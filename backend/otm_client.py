"""Thin OpenTripMap client used when an API key is configured."""

from __future__ import annotations

from typing import List

import httpx

from config import Settings
from seed_loader import Place
from tags_vocab import normalize_tags

BASE_URL = "https://api.opentripmap.com/0.1/ru/places"


def is_enabled(settings: Settings) -> bool:
    return bool(settings.otm_api_key)


def fetch_places(settings: Settings, limit: int = 10) -> List[Place]:
    """Fetch a simple list of places around Rostov-on-Don."""
    api_key = settings.otm_api_key
    if not api_key:
        return []

    params = {
        "apikey": api_key,
        "lat": 47.222078,
        "lon": 39.720349,
        "radius": 15000,
        "limit": limit,
        "kinds": "museums,foods,interesting_places",
    }

    with httpx.Client(base_url=BASE_URL, timeout=15) as client:
        response = client.get("/radius", params=params)
        response.raise_for_status()
        data = response.json()

    features = data.get("features", [])
    results: List[Place] = []
    for feature in features:
        properties = feature.get("properties", {})
        geometry = feature.get("geometry", {})
        coords = geometry.get("coordinates", [None, None])
        if None in coords:
            continue
        raw_tags = (properties.get("kinds") or "").split(",")
        results.append(
            Place(
                id=str(properties.get("xid")),
                name=properties.get("name") or "Неизвестное место",
                lat=float(coords[1]),
                lon=float(coords[0]),
                city="Ростов-на-Дону",
                tags=normalize_tags(raw_tags),
                description=properties.get("wikipedia_extracts", {}).get("text", ""),
            )
        )
    return results
