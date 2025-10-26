#!/usr/bin/env python3
"""Generate frontend runtime config from the backend .env file."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict

ROOT_DIR = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT_DIR / ".env"
FRONTEND_CONFIG = ROOT_DIR / "frontend" / "config.js"


def parse_env(path: Path) -> Dict[str, str]:
    """Parse a minimal subset of .env files (KEY=VALUE lines)."""
    if not path.exists():
        raise FileNotFoundError(f".env file not found at {path}")

    values: Dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def write_frontend_config(values: Dict[str, str]) -> None:
    """Render config.js with the DGIS API keys."""
    map_key = values.get("DGIS_API_KEY") or os.getenv("DGIS_API_KEY")
    directions_key = values.get("DGIS_DIRECTIONS_API_KEY") or os.getenv("DGIS_DIRECTIONS_API_KEY") or map_key

    if not map_key:
        raise RuntimeError("DGIS_API_KEY is missing in environment or .env")

    if not directions_key:
        raise RuntimeError("DGIS_DIRECTIONS_API_KEY is missing and fallback to DGIS_API_KEY failed")

    FRONTEND_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    payload = (
        "window.__CONFIG__ = "
        f"{{ DGIS_MAPGL_API_KEY: {json.dumps(map_key)}, DGIS_DIRECTIONS_API_KEY: {json.dumps(directions_key)} }};\n"
    )
    FRONTEND_CONFIG.write_text(payload, encoding="utf-8")


def main() -> None:
    values = parse_env(ENV_FILE)
    write_frontend_config(values)
    print(f"Generated {FRONTEND_CONFIG}")


if __name__ == "__main__":
    main()
