from __future__ import annotations
from dataclasses import dataclass
from typing import List, Optional

@dataclass(frozen=True)
class SearchSpec:
    q: str
    types: Optional[str] = None  # CSV из 2ГИС типов: "branch,attraction" и т.п.

# Канонические -> список поисковых спецификаций
CANONICAL_TO_SPECS: dict[str, list[SearchSpec]] = {
    # культура/история
    "museum":   [SearchSpec("музей", "branch,attraction"), SearchSpec("выставка", "branch")],
    "art":      [SearchSpec("галерея", "branch,attraction"), SearchSpec("театр", "branch")],
    "history":  [SearchSpec("исторический музей", "branch,attraction"), SearchSpec("памятник", "attraction")],
    "architecture": [SearchSpec("архитектура", "attraction"), SearchSpec("особняк", "branch,building")],

    # прогулки/природа
    "park":     [SearchSpec("парк", "adm_div.place,attraction"), SearchSpec("сквер", "adm_div.place")],
    "walk":     [SearchSpec("набережная", "adm_div.place,attraction"), SearchSpec("пешеходная улица", "adm_div.place")],
    "viewpoint":[SearchSpec("обзорная площадка", "attraction")],
    "waterfront":[SearchSpec("набережная", "adm_div.place,attraction")],

    # еда/кофе/семья/спорт
    "food":     [SearchSpec("ресторан", "branch"), SearchSpec("столовая", "branch")],
    "coffee":   [SearchSpec("кофейня", "branch"), SearchSpec("кафе", "branch")],
    "family":   [SearchSpec("детский центр", "branch"), SearchSpec("семейные развлечения", "adm_div.place,attraction")],
    "sport":    [SearchSpec("спорт", "branch,adm_div.place")],

    # общее
    "poi":      [SearchSpec("достопримечательности", "attraction,adm_div.place")],
}

def plan_queries(tags: list[str]) -> list[SearchSpec]:
    """Из канонических тегов собрать компактный набор запросов к Places API."""
    if not tags:
        return [SearchSpec("достопримечательности", "attraction,adm_div.place")]

    specs: list[SearchSpec] = []
    seen: set[tuple[str, Optional[str]]] = set()

    for t in tags:
        bucket = CANONICAL_TO_SPECS.get(t, [SearchSpec(t)])
        for s in bucket:
            key = (s.q, s.types)
            if key in seen:
                continue
            seen.add(key)
            specs.append(s)

    # ограничим разумным количеством, чтобы не бомбить API
    return specs[:12]
