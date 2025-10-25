"""Load seed places into memory."""

from __future__ import annotations

import json
from pathlib import Path
from typing import List

from typing_extensions import TypedDict

from tags_vocab import normalize_tags


class Place(TypedDict, total=False):
    id: str
    name: str
    lat: float
    lon: float
    city: str
    tags: list[str]
    description: str


SEED_PATH = Path(__file__).parent / "data" / "places_seed.json"


def load_seed() -> List[Place]:
    """Return the list of seed places shipped with the repository."""
    with SEED_PATH.open("r", encoding="utf-8") as fh:
        data: List[Place] = json.load(fh)

    for place in data:
        place["tags"] = normalize_tags(place.get("tags", []))

    return data
