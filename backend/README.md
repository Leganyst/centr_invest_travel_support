# Backend API

Простой REST-сервис на FastAPI, который подбирает однодневный маршрут и возвращает список остановок вместе с содержимым ICS. Данные о местах берём из 2ГИС (по радиусу вокруг пользователя) с кэшем на диске, сиды остаются как резерв.

## Эндпоинты
- `GET /healthz` — быстрое здоровье (`{"ok": true}`).
- `GET /places` — отладочный список мест. Поддерживает `q`, `lat`, `lon`, `radius` (до 2000 м). Без ключа 2ГИС вернёт сиды.
- `POST /plan` — принимает предпочтения и возвращает маршрут, суммарное время и текст ICS. Параметры: `date`, `tags`, опционально `user_location {lat,lon}`, `radius_m`, `budget`, `pace`.
- `POST /llm/next` — вспомогательная ручка для шага диалога: на вход `{"known_prefs":{...}}`, на выход либо следующий вопрос (`mode="ask"`), либо готовые параметры (`mode="ready"`).
- `POST /llm/explain` — принимает `prefs` и `stops`, ответом отдаёт короткое объяснение маршрута.

## Запуск
- Docker: `docker compose -f ../deploy/docker-compose.yml up backend`
- Локально: `pip install -r requirements.txt` → `uvicorn app:app --reload`

### Фронтенд (Vite + React)
- `cd frontend && npm install`
- `npm run dev` для разработки (Vite dev server на `http://localhost:5173`)
- `npm run build` для продакшена — бандл оказывается в `frontend/dist`, FastAPI раздаёт его по `GET /`
- Публичный ключ MapGL (`MAPGL_PUBLIC_KEY`) возьмите в кабинете 2ГИС, добавьте origin `http://127.0.0.1:8000` и `http://localhost:8000` в ограничения. Для тестов можно указать `demo`.

## Примеры
```bash
curl "http://localhost:8080/places?q=музей&lat=47.220&lon=39.720&radius=1500" | jq '.[0]'

curl -X POST http://localhost:8080/plan \
  -H 'Content-Type: application/json' \
  -d '{
    "date":"2025-10-26",
    "tags":["history","food"],
    "user_location":{"lat":47.2231,"lon":39.7180},
    "radius_m":1500
  }'

curl -X POST http://localhost:8080/llm/next \
  -H 'Content-Type: application/json' \
  -d '{"known_prefs": {"date": "2025-10-26"}}'
```

## Переменные окружения
- `PORT` — порт (по умолчанию 8080).
- `DGIS_API_KEY` — ключ 2ГИС (обязателен для продакшена, демо ключ в описании задачи).
- `DGIS_LOCALE` — язык результатов (по умолчанию `ru_RU`).
- `DGIS_PAGE_SIZE`, `DGIS_MAX_PAGES` — пагинация при запросе 2ГИС.
- `DGIS_DEFAULT_Q` — запрос по умолчанию, если теги не заданы.
- `CACHE_TTL_PLACES_SEC` — TTL для кэша мест (секунды).
- `CACHE_DIR` — директория для файлового кэша.
- `LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL` — интеграция с LLM (опционально).
- `OTM_API_KEY` — оставлен для обратной совместимости (не используется по умолчанию).

### План Б
Если 2ГИС недоступен или ключ не задан — сервис работает только на seed JSON. Если LLM не настроен, ручки `/llm/*` возвращают «резервные» ответы и готовый скрипт вопросов.
