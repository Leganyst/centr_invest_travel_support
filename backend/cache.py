"""Simple two-layer cache for API responses."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any, Dict

_MEMORY_CACHE: Dict[str, tuple[float, Any]] = {}


def make_key(endpoint: str, params: Dict[str, Any]) -> str:
    """Create a deterministic cache key from endpoint name and parameters."""
    payload = json.dumps({"endpoint": endpoint, "params": params}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def cache_get(cache_dir: str, key: str) -> Any | None:
    """Try to read value from in-memory cache first, then from filesystem."""
    now = time.time()
    memory_entry = _MEMORY_CACHE.get(key)
    if memory_entry:
        expires_at, value = memory_entry
        if expires_at > now:
            print(f"[CACHE] HIT memory {key}")
            return value
        _MEMORY_CACHE.pop(key, None)

    path = _cache_path(cache_dir, key)
    if not path.exists():
        print(f"[CACHE] MISS disk {key}")
        return None
    try:
        with path.open("r", encoding="utf-8") as fp:
            payload = json.load(fp)
    except (json.JSONDecodeError, OSError):
        path.unlink(missing_ok=True)
        print(f"[CACHE] CORRUPT {key}")
        return None

    expires_at = payload.get("expires_at", 0)
    if expires_at <= now:
        path.unlink(missing_ok=True)
        print(f"[CACHE] STALE {key}")
        return None

    value = payload.get("value")
    _MEMORY_CACHE[key] = (expires_at, value)
    print(f"[CACHE] HIT disk {key}")
    return value


def cache_set(cache_dir: str, key: str, value: Any, ttl_seconds: int) -> None:
    """Persist value in memory and disk caches."""
    expires_at = time.time() + ttl_seconds
    _MEMORY_CACHE[key] = (expires_at, value)

    path = _cache_path(cache_dir, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"expires_at": expires_at, "value": value}
    tmp_path = path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False)
    tmp_path.replace(path)
    print(f"[CACHE] STORE {key} ttl={ttl_seconds}s")


def _cache_path(cache_dir: str, key: str) -> Path:
    return Path(cache_dir).expanduser().resolve() / f"{key}.json"
