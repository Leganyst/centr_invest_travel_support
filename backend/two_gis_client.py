"""Client for 2GIS Places API with region/polygon support and caching."""

from __future__ import annotations

import re
import time
from typing import Any, Dict, Iterable, List, Tuple, Optional
from urllib.parse import urlencode

import httpx

from cache import cache_get, cache_set, make_key
from config import Settings
from seed_loader import Place
from tags_vocab import normalize_tags
from tag_queries import SearchSpec


BASE_URL = "https://catalog.api.2gis.com/3.0/items"
# Поля (без спорных address_name): геоточка, рубрики, описание, «читаемый» адрес
DEFAULT_FIELDS = "items.point,items.rubrics,items.description,items.full_address_name"

# ---------- Exceptions ----------

class DgisError(RuntimeError):
    """Base error for 2GIS client."""

class DgisAuthError(DgisError):
    """Authorization/forbidden error (wrong or expired key)."""

class DgisQuotaError(DgisError):
    """Rate limit exceeded."""


# ---------- Feature flags ----------

def is_enabled(settings: Settings) -> bool:
    return bool(getattr(settings, "dgis_api_key", "") and settings.dgis_api_key.strip())


# ---------- Helpers ----------

def _sanitize_key(raw: str) -> str:
    # Очищаем от случайных пробелов/невидимых символов
    return re.sub(r"[^A-Za-z0-9\-]", "", (raw or ""))

def _mask_key(k: str) -> str:
    k = (k or "").strip()
    return "***" if len(k) <= 6 else f"{k[:3]}***{k[-3:]}"

def _build_query_url(base: str, params: Dict[str, Any]) -> str:
    clean = {k: str(v) for k, v in params.items() if v is not None}
    return f"{base}?{urlencode(clean, doseq=True)}"

def _bbox_around(lon: float, lat: float, dlon: float = 2.0, dlat: float = 1.5) -> tuple[tuple[float,float], tuple[float,float]]:
    """
    Возвращает bbox **в формате 2ГИС**:
    point1 = (left, top), point2 = (right, bottom)
    """
    left = lon - dlon
    right = lon + dlon
    top = lat + dlat
    bottom = lat - dlat
    return ((left, top), (right, bottom))

def fetch_specs_in_region(
    settings: Settings,
    user_point: tuple[float, float],           # (lon, lat)
    specs: list[SearchSpec],
    region_name: str = "Ростовская область",
) -> list[Place]:
    """Выполнить набор SearchSpec во всей области с сортировкой по дистанции от пользователя."""
    lon, lat = user_point
    wkt = get_region_polygon_wkt(settings, region_name)
    bbox_fallback = _bbox_around(lon, lat) if not wkt else None

    collected: list[Place] = []
    seen: set[str] = set()

    for s in specs:
        batch = fetch_places_in_area(
            settings,
            q=s.q,
            polygon_wkt=wkt,
            bbox=bbox_fallback,                 # если wkt нет — ограничим прямоугольником
            location=(lon, lat),
            force_types=s.types,
        )
        for p in batch:
            pid = p.get("id") or f"{p['lat']},{p['lon']}"
            if pid in seen:
                continue
            seen.add(pid)
            collected.append(p)

    return collected


# Простая эвристика типов под текст запроса
FOOD_KWS = ("ресторан", "рестораны", "кафе", "кофейня", "кофейни", "еда", "бар", "столовая")
CULTURE_KWS = ("музей", "музеи", "галерея", "галереи", "театр", "театры", "историчес", "архитектур")
NATURE_KWS = ("парк", "парки", "набережн", "пляж", "сквер", "сад", "природа")

def _types_for_query(q: str) -> Optional[str]:
    ql = (q or "").lower()
    types: List[str] = []
    if any(k in ql for k in FOOD_KWS):
        types.append("branch")                   # рестораны/кафе — это компании
    if any(k in ql for k in CULTURE_KWS):
        types.extend(["branch", "attraction"])   # музеи бывают как company, так и attraction
    if any(k in ql for k in NATURE_KWS):
        types.extend(["adm_div.place", "attraction"])
    if not types:
        return None
    # порядок: пусть branch идёт первым
    seen = set()
    ordered = []
    for t in (["branch"] + [t for t in types if t != "branch"]):
        if t not in seen:
            seen.add(t)
            ordered.append(t)
    return ",".join(ordered)


# ---------- Low level HTTP ----------

def _request(settings: Settings, params: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Все параметры (включая key) шлём в QUERY. Обрабатываем meta.code."""
    retries = 2
    backoff = 0.5

    params = dict(params)
    params["key"] = _sanitize_key(params.get("key", ""))

    headers: Dict[str, str] = {"User-Agent": "centr-invest-travel/1.0 (+2GIS client)"}
    # Если в ЛК ключ ограничен по заголовкам — можно пробросить:
    if getattr(settings, "dgis_referer", None):
        headers["Referer"] = settings.dgis_referer
    if getattr(settings, "dgis_origin", None):
        headers["Origin"] = settings.dgis_origin

    for attempt in range(retries + 1):
        try:
            url = _build_query_url(BASE_URL, params)
            print(f"[2GIS] GET {BASE_URL}?...(key={_mask_key(params['key'])}) page={params.get('page')}")

            with httpx.Client(timeout=20) as client:
                resp = client.get(url, headers=headers)

            try:
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status in {401, 403}:
                    try:
                        meta = exc.response.json().get("meta", {}) or {}
                        message = ((meta.get("error") or {}).get("message")) or exc.response.text
                    except Exception:
                        message = exc.response.text
                    raise DgisAuthError(f"2GIS HTTP {status}: {message}") from exc
                if status == 429:
                    if attempt < retries:
                        sleep_for = backoff * (2 ** attempt)
                        print(f"[2GIS] HTTP 429 retry in {sleep_for:.1f}s")
                        time.sleep(sleep_for)
                        continue
                    raise DgisQuotaError("2GIS HTTP 429: rate limit exceeded") from exc
                if status in {500, 502, 503, 504} and attempt < retries:
                    sleep_for = backoff * (2 ** attempt)
                    print(f"[2GIS] HTTP {status} retry in {sleep_for:.1f}s")
                    time.sleep(sleep_for)
                    continue
                raise

            data = resp.json()
            meta = data.get("meta", {}) or {}
            code = meta.get("code", 200)

            if code == 200:
                items = (data.get("result") or {}).get("items", [])
                print(f"[2GIS] {len(items)} items page={params.get('page')}")
                return items

            if code == 404:
                print(f"[2GIS] no results page={params.get('page')} q={params.get('q')}")
                return []

            if code == 403:
                message = ((meta.get("error") or {}).get("message")) or "Authorization error"
                raise DgisAuthError(f"2GIS error {code}: {message}")

            if code == 429:
                if attempt < retries:
                    sleep_for = backoff * (2 ** attempt)
                    print(f"[2GIS] meta 429 retry in {sleep_for:.1f}s")
                    time.sleep(sleep_for)
                    continue
                raise DgisQuotaError("2GIS meta 429: rate limit exceeded")

            raise DgisError(f"2GIS error: {meta}")

        except httpx.RequestError as exc:
            if attempt < retries:
                sleep_for = backoff * (2 ** attempt)
                print(f"[2GIS] request error {exc!s} retry in {sleep_for:.1f}s")
                time.sleep(sleep_for)
                continue
            raise DgisError(f"2GIS request failed: {exc}") from exc

    return []


# ---------- Public search APIs ----------

def _params_common(settings: Settings, q: str, page: int, page_size: int) -> Dict[str, Any]:
    return {
        "q": q,
        "page": page,
        "page_size": page_size,
        "locale": settings.dgis_locale,
        "fields": DEFAULT_FIELDS,
        "key": settings.dgis_api_key.strip(),
    }

def fetch_places_by_radius(
    settings: Settings,
    point: Tuple[float, float],          # ожидаем (lon, lat)
    radius_m: int,
    q: str,
    *,
    location: Tuple[float, float] | None = None,
    force_types: str | None = None,
) -> List[Place]:
    """Поиск в радиусе от точки. Без жёсткой привязки к городу."""
    if not is_enabled(settings):
        raise DgisAuthError("2GIS API key is missing. Set settings.dgis_api_key.")

    lon, lat = point
    radius_m = max(100, min(radius_m, 5000))
    page_size = settings.dgis_page_size
    types_csv = force_types if force_types is not None else _types_for_query(q)

    collected: List[Place] = []

    for page in range(1, settings.dgis_max_pages + 1):
        params = _params_common(settings, q, page, page_size)
        params.update({
            "point": f"{lon},{lat}",      # ПОРЯДОК: lon,lat
            "radius": radius_m,
            "sort": "distance",
        })
        if location:
            loc_lon, loc_lat = location
            params["location"] = f"{loc_lon},{loc_lat}"
        if types_csv:
            params["type"] = types_csv

        cache_key = make_key("2gis_radius", {**params})
        cached = cache_get(settings.cache_dir, cache_key)
        if cached is not None:
            items = cached
        else:
            items = _request(settings, params)
            cache_set(settings.cache_dir, cache_key, items, settings.cache_ttl_places_sec)

        if not items:
            break

        collected.extend(_to_places(items))
        if len(items) < page_size:
            break
        time.sleep(0.2)

    return collected


def fetch_places_in_area(
    settings: Settings,
    q: str,
    *,
    polygon_wkt: str | None = None,       # ограничение по многоугольнику (область)
    bbox: tuple[tuple[float,float], tuple[float,float]] | None = None,  # ((lon1,lat1),(lon2,lat2))
    city_id: str | None = None,           # альтернатива: агломерация
    location: tuple[float,float] | None = None,  # точка пользователя
    force_types: str | None = None,
) -> list[Place]:
    """Поиск внутри области/прямоугольника/города с сортировкой по близости к пользователю."""
    if not is_enabled(settings):
        raise DgisAuthError("2GIS API key is missing. Set settings.dgis_api_key.")

    page_size = settings.dgis_page_size
    types_csv = force_types if force_types is not None else _types_for_query(q)

    collected: List[Place] = []

    for page in range(1, settings.dgis_max_pages + 1):
        params = _params_common(settings, q, page, page_size)
        if polygon_wkt:
            params["polygon"] = polygon_wkt
        elif bbox:
            (lon1, lat1), (lon2, lat2) = bbox
            # Нормализация: левый/правый и верх/низ
            left   = min(lon1, lon2)
            right  = max(lon1, lon2)
            top    = max(lat1, lat2)
            bottom = min(lat1, lat2)
            params["point1"] = f"{left},{top}"       # левый-верхний
            params["point2"] = f"{right},{bottom}"   # правый-нижний
        elif city_id:
            params["city_id"] = city_id

        if location:
            lon, lat = location
            params["location"] = f"{lon},{lat}"
            params["sort"] = "distance"

        if types_csv:
            params["type"] = types_csv

        cache_key = make_key("2gis_area", {**params})
        cached = cache_get(settings.cache_dir, cache_key)
        if cached is not None:
            items = cached
        else:
            items = _request(settings, params)
            cache_set(settings.cache_dir, cache_key, items, settings.cache_ttl_places_sec)

        if not items:
            break

        collected.extend(_to_places(items))
        if len(items) < page_size:
            break
        time.sleep(0.2)

    return collected


# ---------- Admin polygon (Ростовская область) ----------

def _wkt_from_selection(selection: Any) -> Optional[str]:
    """
    Нормализует разные варианты selection в WKT (POLYGON/MULTIPOLYGON).
    Поддерживаем формы:
      - [[ [ [lon,lat], ... ] , [hole], ... ],  ... ]  # список полигонов = MULTIPOLYGON
      - [ [ [lon,lat], ... ] , [hole], ... ]           # один полигон с кольцами
      - [ [lon,lat], [lon,lat], ... ]                  # одно кольцо
      - { "type":"Polygon"|"MultiPolygon", "coordinates":[...] }
    Возвращает None, если ничего валидного собрать не удалось.
    """

    def is_point(x) -> bool:
        return isinstance(x, (list, tuple)) and len(x) >= 2 and all(isinstance(v, (int, float)) for v in x[:2])

    def is_ring(x) -> bool:
        # Кольцо = >=4 точек и все точки валидные
        return isinstance(x, (list, tuple)) and len(x) >= 4 and all(is_point(p) for p in x)

    def is_rings(x) -> bool:
        return isinstance(x, (list, tuple)) and len(x) >= 1 and all(is_ring(r) for r in x)

    def is_polys(x) -> bool:
        return isinstance(x, (list, tuple)) and len(x) >= 1 and all(is_rings(poly) for poly in x)

    def close_ring(ring: list[list[float]]) -> list[list[float]]:
        if not ring:
            return ring
        if ring[0][0] != ring[-1][0] or ring[0][1] != ring[-1][1]:
            return ring + [ring[0]]
        return ring

    def ring_to_wkt(ring: list[list[float]]) -> str:
        ring = close_ring(ring)
        coords = ", ".join(f"{float(pt[0])} {float(pt[1])}" for pt in ring)
        return f"({coords})"

    # 1) GeoJSON-подобный словарь
    if isinstance(selection, dict) and "coordinates" in selection:
        coords = selection.get("coordinates")
        gtype = (selection.get("type") or "").lower()
        # MultiPolygon: [ [ [ [lon,lat], ... ] , [hole], ... ],  [ ... ], ... ]
        if gtype == "multipolygon":
            polys: list[list[list[list[float]]]] = []
            for poly in coords or []:
                # poly: [ring1, ring2, ...]
                good_rings = [r for r in (poly or []) if is_ring(r)]
                if good_rings:
                    polys.append(good_rings)
            if not polys:
                return None
            parts = []
            for rings in polys:
                parts.append("(" + ", ".join(ring_to_wkt(r) for r in rings) + ")")
            return "MULTIPOLYGON(" + ", ".join(parts) + ")"
        # Polygon: [ [ [lon,lat], ... ] , [hole], ... ]
        elif gtype == "polygon":
            rings = [r for r in (coords or []) if is_ring(r)]
            if not rings:
                return None
            return "POLYGON(" + ", ".join(ring_to_wkt(r) for r in rings) + ")"

    # 2) Списки разных вложенностей
    x = selection
    # case: список полигонов
    if is_polys(x):
        parts = []
        for rings in x:
            parts.append("(" + ", ".join(ring_to_wkt(r) for r in rings) + ")")
        return "MULTIPOLYGON(" + ", ".join(parts) + ")"
    # case: один полигон (rings)
    if is_rings(x):
        return "POLYGON(" + ", ".join(ring_to_wkt(r) for r in x) + ")"
    # case: одно кольцо
    if is_ring(x):
        return "POLYGON(" + ring_to_wkt(x) + ")"
    # case: «плоский» список точек — трактуем как одно кольцо
    if isinstance(x, (list, tuple)) and x and all(is_point(p) for p in x):
        ring = list(x)
        if len(ring) >= 4:
            return "POLYGON(" + ring_to_wkt(ring) + ")"

    # Ничего валидного
    return None

def get_region_polygon_wkt(settings: Settings, region_query: str = "Ростовская область") -> Optional[str]:
    """Возвращает (и кэширует) WKT-многоугольник региона для polygon=..."""
    cache_key = make_key("2gis_region_wkt", {"q": region_query, "locale": settings.dgis_locale})
    cached = cache_get(settings.cache_dir, cache_key)
    if cached:
        return cached

    params = {
        "q": region_query,
        "type": "adm_div.region",
        "fields": "items.geometry.selection,items.name,items.geometry.selection_type",
        "page_size": 1,
        "page": 1,
        "locale": settings.dgis_locale,
        "key": settings.dgis_api_key.strip(),
    }
    items = _request(settings, params)
    if not items:
        print(f"[2GIS] region '{region_query}' not found")
        return None

    geometry = (items[0].get("geometry") or {})
    selection = geometry.get("selection")
    # Иногда приходит уже как GeoJSON с type/coordinates
    if isinstance(selection, dict) and "type" in selection and "coordinates" in selection:
        wkt = _wkt_from_selection(selection)
    else:
        wkt = _wkt_from_selection(selection)

    if not wkt:
        print("[2GIS] region geometry selection not parseable; fallback will be used by caller")
        return None

    # кэш подольше (неделя)
    cache_set(settings.cache_dir, cache_key, wkt, settings.cache_ttl_places_sec * 24 * 7)
    return wkt

def fetch_near_user_in_region(
    settings: Settings,
    user_point: tuple[float, float],      # (lon, lat)
    queries: list[str],
    region_name: str = "Ростовская область",
) -> list[Place]:
    """Агрегирующий поиск: все запросы во ВСЕЙ области, отсортировано по близости к пользователю."""
    lon, lat = user_point
    wkt = get_region_polygon_wkt(settings, region_name)
    collected: list[Place] = []
    seen_ids: set[str] = set()

    for q in queries:
        batch = fetch_places_in_area(
            settings,
            q=q,
            polygon_wkt=wkt,
            location=(lon, lat),
            force_types=None,  # подберём по эвристике
        )
        for p in batch:
            pid = p.get("id") or f"{p['lat']},{p['lon']}"
            if pid in seen_ids:
                continue
            seen_ids.add(pid)
            collected.append(p)

    return collected


# ---------- Transform ----------

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
        tags = normalize_tags(rubrics) or normalize_tags([item.get("type") or "poi"])

        city_or_address = (
            item.get("full_address_name")
            or (item.get("address") or {}).get("name")
            or ""
        )

        place: Place = Place(
            id=str(item.get("id") or f"{lat},{lon}"),
            name=(item.get("name") or "Неизвестное место"),
            lat=lat,
            lon=lon,
            city=city_or_address,
            tags=tags,
            description=item.get("description", "") or "",
        )
        results.append(place)
    return results
