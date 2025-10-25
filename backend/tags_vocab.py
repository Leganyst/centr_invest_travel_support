"""Helpers for working with canonical tags across data sources."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Iterable, List

_VOCAB_PATH = Path(__file__).with_name("tags_vocab.json")


@lru_cache(maxsize=1)
def _vocab() -> dict[str, str]:
    with _VOCAB_PATH.open("r", encoding="utf-8") as fp:
        return json.load(fp)


def normalize_tags(raw_tags: Iterable[str]) -> List[str]:
    """Map arbitrary tags to the canonical vocabulary."""
    vocab = _vocab()
    normalized = []
    for tag in raw_tags:
        value = (tag or "").strip().lower()
        if not value:
            continue
        normalized.append(vocab.get(value, value))
    seen: set[str] = set()
    result: List[str] = []
    for item in normalized:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def allowed_tags() -> List[str]:
    """Expose canonical tags for UI/LLM consumers."""
    vocab = _vocab()
    canonical = set(vocab.values())
    return sorted(canonical)
