"""Client for 2GIS Places API with caching support."""

from __future__ import annotations

import time
from typing import Any, Dict, Iterable, List, Tuple

import httpx

from cache import cache_get, cache_set, make_key
from config import Settings
from seed_loader import Place
from tags_vocab import normalize_tags

BASE_URL = "https://catalog.api.2gis.com/3.0/items"
DEFAULT_TYPES = "attraction,adm_div.place"
DEFAULT_FIELDS = "items.point,items.address_name,items.rubrics,items.description"


def is_enabled(settings: Settings) -> bool:
    return bool(settings.dgis_api_key)


def resolve_city_id(settings: Settings, lon: float, lat: float) -> str | None:
    """Placeholder for resolving city identifiers (not required for radius search)."""
    # Radius-based search does not require a city identifier, keeping stub for future use.
    return None


def fetch_places_by_radius(
    settings: Settings,
    point: Tuple[float, float],
    radius_m: int,
    q: str,
    *,
    location: Tuple[float, float] | None = None,
) -> List[Place]:
    """Fetch places in a radius around a point, leveraging cache and pagination."""
    lon, lat = point
    radius_m = max(100, min(radius_m, 2000))  # demo key limitation
    collected: List[Place] = []

    for page in range(1, settings.dgis_max_pages + 1):
        params = {
            "q": q,
            "point": f"{lon},{lat}",
            "radius": radius_m,
            "type": DEFAULT_TYPES,
            "page": page,
            "page_size": settings.dgis_page_size,
            "locale": settings.dgis_locale,
            "fields": DEFAULT_FIELDS,
            "key": settings.dgis_api_key,
        }
        if location:
            loc_lon, loc_lat = location
            params["location"] = f"{loc_lon},{loc_lat}"
            params["search_nearby"] = "true"

        cache_key = make_key(
            "2gis_radius",
            {
                "lon": round(lon, 4),
                "lat": round(lat, 4),
                "radius": radius_m,
                "q": q,
                "page": page,
                "page_size": settings.dgis_page_size,
                "location": tuple(round(v, 4) for v in location) if location else None,
            },
        )

        cached = cache_get(settings.cache_dir, cache_key)
        if cached is not None:
            collected.extend(_to_places(cached))
            continue

        items = _request(settings, params)
        if not items:
            break
        cache_set(settings.cache_dir, cache_key, items, settings.cache_ttl_places_sec)
        collected.extend(_to_places(items))
        if len(items) < settings.dgis_page_size:
            break
        time.sleep(0.2)

    return collected


def _request(settings: Settings, params: Dict[str, Any]) -> List[Dict[str, Any]]:
    retries = 2
    backoff = 0.5
    for attempt in range(retries + 1):
        try:
            with httpx.Client(timeout=20) as client:
                resp = client.get(BASE_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
            meta = data.get("meta", {})
            code = meta.get("code")
            if code == 404:
                print(f"[2GIS] no results page={params['page']} query={params.get('q')}")
                return []
            if code != 200:
                raise RuntimeError(f"2GIS error: {meta}")
            items = data.get("result", {}).get("items", [])
            print(f"[2GIS] {len(items)} items page={params['page']}")
            return items
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status in {429, 500, 502, 503, 504} and attempt < retries:
                sleep_for = backoff * (2 ** attempt)
                print(f"[2GIS] retry status={status} wait={sleep_for:.1f}s")
                time.sleep(sleep_for)
                continue
            raise
        except httpx.RequestError as exc:
            if attempt < retries:
                sleep_for = backoff * (2 ** attempt)
                print(f"[2GIS] request error {exc} wait={sleep_for:.1f}s")
                time.sleep(sleep_for)
                continue
            raise

    return []


def _to_places(items: Iterable[Dict[str, Any]]) -> List[Place]:
    results: List[Place] = []
    for item in items:
        raw_point = item.get("point") or {}
        try:
            lat = float(raw_point.get("lat"))
            lon = float(raw_point.get("lon"))
        except (TypeError, ValueError):
            continue

        rubrics = [rubric.get("name", "") for rubric in item.get("rubrics", [])]
        tags = normalize_tags(rubrics)
        if not tags:
            # fall back to type or default tag
            tags = normalize_tags([item.get("type") or "poi"])

        place: Place = Place(
            id=str(item.get("id")),
            name=item.get("name") or "Неизвестное место",
            lat=lat,
            lon=lon,
            city=item.get("address_name") or "Ростов-на-Дону",
            tags=tags,
            description=item.get("description", ""),
        )
        results.append(place)
    return results
