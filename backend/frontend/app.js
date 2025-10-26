(function (global) {
  "use strict";

  const TEST_POINTS = [
    {
      title: "Набережная Ростова",
      desc: "Главная прогулочная зона — отличный старт пешего маршрута",
      lat: 47.214228,
      lon: 39.710725,
    },
    {
      title: "Парк Горького",
      desc: "Центральный парк с аттракционами и тенистыми аллеями",
      lat: 47.222299,
      lon: 39.710949,
    },
    {
      title: "Собор Рождества Пресвятой Богородицы",
      desc: "Исторический собор XIX века на Соборной площади",
      lat: 47.221629,
      lon: 39.714874,
    },
    {
      title: "Улица Пушкинская",
      desc: "Пешеходная улица с кафе и архитектурой начала XX века",
      lat: 47.225353,
      lon: 39.719735,
    },
    {
      title: "ЦГИК имени Горького",
      desc: "Завершение маршрута — культурный центр и кинозал",
      lat: 47.229278,
      lon: 39.726331,
    },
  ];

  const DEFAULT_USER_LOCATION = {
    lat: 47.2221,
    lon: 39.7203,
    accuracy: null,
  };

  const appState = {
    points: [],
    route: null,
    routePlan: null,
    prefs: { city: "Ростов-на-Дону", tags: [], budget: "low", pace: "normal" },
    userLocation: { ...DEFAULT_USER_LOCATION },
  };

  let mapApi = null;
  let isBuilding = false;

  function getMapKey() {
    return global.__CONFIG__?.DGIS_MAPGL_API_KEY;
  }

  function getDirectionsKey() {
    return global.__CONFIG__?.DGIS_DIRECTIONS_API_KEY || getMapKey();
  }

  function mergeUserLocation(location) {
    if (!location) {
      return;
    }
    appState.userLocation = {
      lat: location.lat,
      lon: location.lon,
      accuracy: location.accuracy ?? null,
      timestamp: location.timestamp ?? Date.now(),
    };
  }

  function requestUserLocation() {
    if (!navigator.geolocation) {
      console.warn("[App] Браузер не поддерживает геолокацию");
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp,
          });
        },
        (error) => {
          console.warn("[App] Не удалось получить геолокацию:", error);
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        },
      );
    });
  }

  function formatTime(value) {
    if (!value) {
      return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  // Загружаем канонические теги из бэка и отдаём их в UI для рендера чекбоксов
  async function loadCanonicalTags() {
    try {
      const res = await fetch("/tags");
      if (!res.ok) throw new Error(`/tags HTTP ${res.status}`);
      const data = await res.json(); // { tags: [...] }
      if (Array.isArray(data.tags)) {
        global.UI.populateTags(data.tags);
      }
    } catch (e) {
      console.warn("[App] Не удалось получить список тегов:", e);
    }
  }

  // Подстраховка: если на форме окажутся неканонические значения — нормализуем на бэке
  async function normalizeTagsClientSide(tags) {
    try {
      const res = await fetch("/normalize_tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      if (!res.ok) throw new Error(`/_normalize HTTP ${res.status}`);
      const data = await res.json(); // { tags: [...] }
      return Array.isArray(data.tags) ? data.tags : tags;
    } catch {
      return tags;
    }
  }


  function updateRouteList() {
    global.UI.renderRouteList(appState.points, appState.route, appState.routePlan);
  }

  async function handleBuildRoute() {
    if (isBuilding) {
      return;
    }
    if (!mapApi) {
      global.alert("Карта ещё не готова. Проверьте подключение 2ГИС.");
      return;
    }
    isBuilding = true;
    global.UI.showToast("Запрашиваем геолокацию…", 2000);

    try {
      const location = await requestUserLocation();
      if (location) {
        mergeUserLocation(location);
        mapApi.setUserLocation(appState.userLocation, { center: true });
      } else if (appState.userLocation) {
        mapApi.setUserLocation(appState.userLocation, { center: true });
      }

      global.UI.showToast("Запрашиваем маршрут у сервера…", 2000);

      const rawTags = Array.isArray(appState.prefs.tags) ? appState.prefs.tags : [];
      const canonTags = await normalizeTagsClientSide(rawTags);

      const requestPayload = {
        date: new Date().toISOString().slice(0, 10),
        city: appState.prefs.city || "Ростов-на-Дону",
        tags: canonTags, // <-- отправляем канонические значения
        budget: appState.prefs.budget || null,
        pace: appState.prefs.pace || null,
      };

      // user_location: координаты — как есть (полная точность),
      // accuracy_m — ТОЛЬКО целое (backend ожидает int)
      if (
        appState.userLocation &&
        appState.userLocation.lat != null &&
        appState.userLocation.lon != null
      ) {
        requestPayload.user_location = {
          lat: appState.userLocation.lat,
          lon: appState.userLocation.lon,
          accuracy_m:
            typeof appState.userLocation.accuracy === "number"
              ? Math.round(appState.userLocation.accuracy)
              : null,
        };
      }

      let planData = null;
      try {
        const response = await fetch("/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        planData = await response.json();
      } catch (error) {
        console.error("[App] Ошибка запроса /plan:", error);
        global.UI.showToast("Не удалось получить маршрут с сервера, используем демо-данные", 2600);
      }

      let effectivePoints = TEST_POINTS;

      if (planData && Array.isArray(planData.stops) && planData.stops.length) {
        const limitedStops = planData.stops.slice(0, 10); // лимит на уровне клиента тоже
        appState.routePlan = { ...planData, stops: limitedStops };

        effectivePoints = limitedStops
          .map((stop, index) => {
            const lat = parseFloat(stop.lat);
            const lon = parseFloat(stop.lon);
            const ok =
              Number.isFinite(lat) &&
              Number.isFinite(lon) &&
              lat >= -90 &&
              lat <= 90 &&
              lon >= -180 &&
              lon <= 180;

            const arriveTime = formatTime(stop.arrive);
            const leaveTime = formatTime(stop.leave);
            const metaParts = [];
            if (arriveTime) metaParts.push(`Прибытие ${arriveTime}`);
            if (leaveTime) metaParts.push(`Отправление ${leaveTime}`);
            if (Array.isArray(stop.tags) && stop.tags.length) metaParts.push(stop.tags.join(", "));

            return ok
              ? {
                  id: index,
                  title: (stop.name && String(stop.name)) || `Точка ${index + 1}`,
                  desc: metaParts.join(" · ") || "",
                  lat,
                  lon,
                  arrive: stop.arrive || null,
                  leave: stop.leave || null,
                  tags: Array.isArray(stop.tags) ? stop.tags : [],
                }
              : null;
          })
          .filter(Boolean);
        global.UI.showToast(
          `Маршрут готов: ${planData.total_time || `${planData.total_minutes} мин`}`,
          2600
        );
      } else {
        appState.routePlan = null;
      }

      appState.points = effectivePoints.length ? effectivePoints : TEST_POINTS;

      mapApi.setMarkers(appState.points);
      const pointsToFit = appState.userLocation
        ? [...appState.points, appState.userLocation]
        : [...appState.points];
      mapApi.fitTo(pointsToFit);

      if (appState.points.length >= 2) {
        const route = await mapApi.buildPedestrianRoute(appState.points);
        appState.route = route;

        // [MOBILE] Сообщаем, что маршрут готов → раскрыть шторку
        document.dispatchEvent(new CustomEvent('app:route-ready'));
        if (route.usedFallback && planData) {
          global.UI.showToast(
            "Не удалось построить точный маршрут на карте, показан приблизительный",
            2800
          );
        }
      } else {
        appState.route = null;
      }

      updateRouteList();
    } catch (error) {
      console.error("[App] Не удалось построить маршрут:", error);
      global.UI.showToast("Ошибка построения маршрута, проверьте консоль");
    } finally {
      isBuilding = false;
    }
  }


  function handleExplain() {
    global.alert("Объяснение будет тут");
  }

  function handleViewRoute() {
    if (!mapApi || !appState.points.length) {
      global.UI.showToast("Сначала постройте маршрут");
      return;
    }
    const pointsToFit = appState.userLocation
      ? [...appState.points, appState.userLocation]
      : [...appState.points];
    mapApi.fitTo(pointsToFit);
    global.UI.scrollRouteList();

    // [MOBILE] Раскрываем список на мобиле + событие
    if (global.MobileUI) global.MobileUI.expandSheet();
    document.dispatchEvent(new CustomEvent('app:view-route'));
  }

  function handlePreferencesChange(prefs) {
    appState.prefs = { ...appState.prefs, ...prefs };
    console.log("[App] Предпочтения обновлены:", appState.prefs);
  }

  function initMap() {
    const mapKey = getMapKey();
    const directionsKey = getDirectionsKey();

    if (!mapKey) {
      console.warn("[App] DGIS_MAPGL_API_KEY отсутствует, карта не будет загружена");
      global.UI.showToast("Нет ключа 2ГИС — карта недоступна");
      return;
    }
    try {
      mapApi = global.FrontendMap.initMap({ mapKey, directionsKey });
      if (appState.userLocation) {
        mapApi.setUserLocation(appState.userLocation, { center: true });
      }
    } catch (error) {
      console.error("[App] Ошибка инициализации карты:", error);
      global.UI.showToast("Карта не загрузилась, смотрите консоль");
    }
  }

  function boot() {
    if (global.location.protocol === "file:") {
      console.warn("[App] Приложение запущено с file://, карта не отобразится");
      global.UI.showToast("Запустите проект через http://localhost, иначе 2ГИС заблокирует ключ");
    }

    initMap();
    loadCanonicalTags();
    global.UI.setStateGetter(() => appState);
    global.UI.renderRouteList(appState.points, appState.route, appState.routePlan);

    // [MOBILE] Инициализируем мобильные улучшения
    if (global.MobileUI) {
      global.MobileUI.init();

      // Необязательный мост: отправлять тосты через MobileUI, чтобы они
      // попадали в единый стек и аккуратно располагались под safe-area.
      if (global.UI && typeof global.UI.showToast === 'function') {
        global.UI.showToast = (m, ms) => global.MobileUI.showToast(m, ms);
      }
    }

    global.UI.init({
      onBuildRoute: handleBuildRoute,
      onExplain: handleExplain,
      onViewRoute: handleViewRoute,
      onPreferencesChange: handlePreferencesChange,
      onChatOpen: () => {
        // Placeholder for future chat integration
      },
    });
  }

  document.addEventListener("DOMContentLoaded", boot);
})(window);
