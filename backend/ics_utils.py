"""Generate ICS payloads for planned routes."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable
from zoneinfo import ZoneInfo

HEADER_TEMPLATE = (
    "BEGIN:VCALENDAR\n"
    "VERSION:2.0\n"
    "PRODID:-//dgtu-hack//route//EN\n"
    "X-WR-CALNAME:{title}\n"
    "X-WR-TIMEZONE:{tzid}\n"
    "BEGIN:VTIMEZONE\n"
    "TZID:{tzid}\n"
    "BEGIN:STANDARD\n"
    "DTSTART:19700329T000000\n"
    "TZOFFSETFROM:+0300\n"
    "TZOFFSETTO:+0300\n"
    "TZNAME:MSK\n"
    "END:STANDARD\n"
    "END:VTIMEZONE\n"
)
ICS_FOOTER = "END:VCALENDAR"


def make_ics(
    stops: Iterable[dict],
    title: str = "Маршрут по Ростову",
    description: str | None = None,
    tzid: str = "Europe/Moscow",
) -> str:
    """Return ICS payload with timezone metadata and optional description."""

    tz = ZoneInfo(tzid)
    header = HEADER_TEMPLATE.format(title=_escape(title), tzid=tzid)
    now_utc = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    events = []
    for idx, stop in enumerate(stops, start=1):
        arrive = _parse_iso(stop["arrive"])
        leave = _parse_iso(stop["leave"])
        arrive_local = _ensure_tz(arrive, tz)
        leave_local = _ensure_tz(leave, tz)
        summary = _escape(f"{idx}. {stop['name']}")
        detail = description or stop.get("description") or ""
        if not detail:
            tag_line = ", ".join(stop.get("tags", []))
            detail = f"Теги: {tag_line}" if tag_line else "Маршрут по городу"
        detail = _escape(detail)
        event = "\n".join(
            [
                "BEGIN:VEVENT",
                f"UID:{arrive_local.strftime('%Y%m%dT%H%M%S')}@dgtu-hack",
                f"DTSTAMP:{now_utc}",
                f"DTSTART;TZID={tzid}:{arrive_local.strftime('%Y%m%dT%H%M%S')}",
                f"DTEND;TZID={tzid}:{leave_local.strftime('%Y%m%dT%H%M%S')}",
                f"SUMMARY:{summary}",
                f"DESCRIPTION:{detail}",
                "END:VEVENT",
            ]
        )
        events.append(event)
    body = "\n".join([header, *events, ICS_FOOTER])
    return body + "\n"


def _parse_iso(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value)
    except ValueError as exc:  # pragma: no cover - defensive only
        raise ValueError(f"Invalid ISO datetime: {value}") from exc


def _ensure_tz(dt: datetime, tz: ZoneInfo) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=tz)
    return dt.astimezone(tz)


def _escape(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )
