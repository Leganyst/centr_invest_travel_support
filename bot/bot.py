"""Telegram bot based on aiogram 3.x with async HTTPie calls."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any

from aiogram import Bot, Dispatcher
from aiogram.enums import ParseMode
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (
    BufferedInputFile,
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
)

from config import Settings


class PlanStates(StatesGroup):
    date = State()
    tags = State()
    budget = State()


TAG_KEYBOARD = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="history"), KeyboardButton(text="nature")],
        [KeyboardButton(text="food"), KeyboardButton(text="art")],
        [KeyboardButton(text="skip")],
    ],
    resize_keyboard=True,
    one_time_keyboard=True,
)

BUDGET_KEYBOARD = ReplyKeyboardMarkup(
    keyboard=[[KeyboardButton(text="low"), KeyboardButton(text="medium"), KeyboardButton(text="high")]],
    resize_keyboard=True,
    one_time_keyboard=True,
)

settings = Settings.load()
bot = Bot(token=settings.telegram_bot_token, parse_mode=ParseMode.HTML)
dp = Dispatcher()


@dp.message(Command("start"))
async def cmd_start(message: Message) -> None:
    await message.answer(
        "Привет! Я помогу спланировать культурный день в Ростове. Наберите /plan, чтобы начать.",
        reply_markup=ReplyKeyboardRemove(),
    )


@dp.message(Command("plan"))
async def cmd_plan(message: Message, state: FSMContext) -> None:
    await state.set_state(PlanStates.date)
    await message.answer(
        "На какую дату планируете поездку? Укажите в формате YYYY-MM-DD.",
        reply_markup=ReplyKeyboardRemove(),
    )


@dp.message(PlanStates.date)
async def handle_date(message: Message, state: FSMContext) -> None:
    text = (message.text or "").strip()
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        await message.answer("Не понял дату. Пример: 2025-10-26")
        return

    await state.update_data(date=parsed.date().isoformat())
    await state.set_state(PlanStates.tags)
    await message.answer(
        "Какие интересы учитывать? Выберите кнопкой или напишите через запятую.",
        reply_markup=TAG_KEYBOARD,
    )


@dp.message(PlanStates.tags)
async def handle_tags(message: Message, state: FSMContext) -> None:
    raw = (message.text or "").strip()
    if raw.lower() == "skip":
        tags: list[str] = []
    else:
        tags = [tag.strip().lower() for tag in raw.replace(";", ",").split(",") if tag.strip()]

    await state.update_data(tags=tags)
    await state.set_state(PlanStates.budget)
    await message.answer(
        "Какой бюджет учитывать? (low / medium / high)",
        reply_markup=BUDGET_KEYBOARD,
    )


@dp.message(PlanStates.budget)
async def handle_budget(message: Message, state: FSMContext) -> None:
    budget = (message.text or "medium").strip().lower()
    await state.update_data(budget=budget)

    await message.answer("Секунду, составляю маршрут…", reply_markup=ReplyKeyboardRemove())

    data = await state.get_data()
    try:
        plan = await request_plan(data)
    except RuntimeError as exc:
        await message.answer(f"Не удалось получить маршрут. Попробуйте позже.\n<code>{exc}</code>")
        await state.clear()
        return

    await message.answer(format_plan(plan["stops"], plan["total_time"]))
    await send_ics(message, plan.get("ics", ""))
    await state.clear()


@dp.message(Command("cancel"))
async def cmd_cancel(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer("Окей, если что — возвращайтесь!", reply_markup=ReplyKeyboardRemove())


async def request_plan(payload: dict[str, Any]) -> dict[str, Any]:
    args = [
        "http",
        "--json",
        "--timeout=20",
        "POST",
        f"{settings.backend_url}/plan",
        f"city={payload.get('city', 'Ростов-на-Дону')}",
        f"date={payload.get('date')}",
        f"tags:={json.dumps(payload.get('tags', []))}",
    ]

    budget = payload.get("budget")
    if budget:
        args.append(f"budget={budget}")

    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()

    if process.returncode != 0:
        error_text = stderr.decode().strip() or "HTTPie exited with non-zero status"
        raise RuntimeError(error_text)

    try:
        return json.loads(stdout.decode())
    except json.JSONDecodeError as exc:  # pragma: no cover - defensive only
        raise RuntimeError(f"Некорректный ответ сервера: {exc}") from exc


def format_plan(stops: list[dict[str, Any]], total_time: str) -> str:
    if not stops:
        return "Пока не получилось подобрать подходящие остановки. Попробуйте другие теги."

    lines = [f"Маршрут на день (~{total_time}):"]
    for idx, stop in enumerate(stops, start=1):
        arrive = stop.get("arrive", "")[11:16]
        leave = stop.get("leave", "")[11:16]
        tags = ", ".join(stop.get("tags", []))
        lines.append(f"{idx}. {stop['name']} ({arrive}-{leave}) — {tags}")
    lines.append("Файл ICS можно добавить в календарь.")
    return "\n".join(lines)


async def send_ics(message: Message, ics_text: str) -> None:
    if not ics_text:
        await message.answer("ICS-файл пока не готов.")
        return

    data = ics_text.encode("utf-8")
    await message.answer_document(
        document=BufferedInputFile(data, filename="route.ics"),
        caption="Добавьте файл в календарь, чтобы сохранить маршрут.",
    )


async def main() -> None:
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
