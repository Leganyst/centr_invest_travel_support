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
    origin: null,
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

  function normalizeOrigin(point) {
    if (!point || point.lat == null || point.lon == null) {
      return null;
    }
    const lat = Number(point.lat);
    const lon = Number(point.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    const accuracyRaw = point.accuracy ?? point.accuracy_m ?? null;
    const accuracyNum = accuracyRaw == null ? null : Number(accuracyRaw);
    return {
      lat,
      lon,
      accuracy: Number.isFinite(accuracyNum) ? accuracyNum : null,
      source: point.source || null,
    };
  }

  function setOrigin(point, options = {}) {
    const normalized = normalizeOrigin(point);
    if (!normalized) {
      appState.origin = null;
      if (mapApi?.clearOrigin) {
        mapApi.clearOrigin();
      }
      global.UI.updateOriginIndicator(null);
      if (options.toast) {
        global.UI.showToast("Старт сброшен, используется центр города", 2400);
      }
      return;
    }

    appState.origin = normalized;
    if (options.updateMap !== false && mapApi?.setOrigin) {
      mapApi.setOrigin({ lat: normalized.lat, lon: normalized.lon });
    }
    if (options.center && mapApi?.fitTo) {
      mapApi.fitTo([{ lat: normalized.lat, lon: normalized.lon }]);
    }
    global.UI.updateOriginIndicator(normalized);
    if (options.toast) {
      let label = "точка на карте";
      if (normalized.source === "geolocation") {
        label = "геолокация";
      } else if (normalized.source && normalized.source !== "map") {
        label = normalized.source;
      }
      global.UI.showToast(`Старт обновлён: ${label}`, 2400);
    }
  }

  function clearOrigin() {
    setOrigin(null, { toast: false });
  }

  async function setOriginFromGeolocation(options = {}) {
    const location = await requestUserLocation();
    if (!location) {
      if (!options.silent) {
        global.UI.showToast("Не удалось определить вашу геолокацию", 2600);
      }
      return null;
    }

    mergeUserLocation(location);
    if (mapApi?.setUserLocation) {
      mapApi.setUserLocation(appState.userLocation, { center: options.center !== false });
    }

    setOrigin(
      { lat: location.lat, lon: location.lon, accuracy: location.accuracy, source: "geolocation" },
      { toast: !options.silent }
    );
    return appState.origin;
  }

  async function ensureOriginForRouting() {
    if (appState.origin) {
      if (appState.origin.source === "geolocation" && appState.userLocation && mapApi?.setUserLocation) {
        mapApi.setUserLocation(appState.userLocation, { center: false });
      }
      return appState.origin;
    }
    return setOriginFromGeolocation({ silent: true, center: true });
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

    try {
      if (!appState.origin) {
        global.UI.showToast("Пробуем определить стартовую точку…", 2200);
      }
      const originPoint = await ensureOriginForRouting();

      global.UI.showToast("Запрашиваем маршрут у сервера…", 2000);

      const rawTags = Array.isArray(appState.prefs.tags) ? appState.prefs.tags : [];
      const canonTags = await normalizeTagsClientSide(rawTags);

      const requestPayload = {
        date: new Date().toISOString().slice(0, 10),
        city: appState.prefs.city || "Ростов-на-Дону",
        tags: canonTags,
        budget: appState.prefs.budget || null,
        pace: appState.prefs.pace || null,
      };

      if (originPoint) {
        requestPayload.user_location = {
          lat: originPoint.lat,
          lon: originPoint.lon,
          accuracy_m:
            typeof originPoint.accuracy === "number" ? Math.round(originPoint.accuracy) : null,
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
        const limitedStops = planData.stops.slice(0, 10);
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
            const descriptionText =
              typeof stop.description === "string" && stop.description.trim()
                ? stop.description.trim()
                : "";
            const metaParts = [];
            if (arriveTime) metaParts.push(`Прибытие ${arriveTime}`);
            if (leaveTime) metaParts.push(`Отправление ${leaveTime}`);
            if (Array.isArray(stop.tags) && stop.tags.length) metaParts.push(stop.tags.join(", "));
            const markerSummary = [descriptionText, ...metaParts].filter(Boolean).join(" · ");
            const title =
              (stop.name && String(stop.name).trim()) || `Точка ${index + 1}`;

            return ok
              ? {
                  id: index,
                  name: title,
                  title,
                  description: descriptionText || (metaParts.join(" · ") || ""),
                  metaSummary: metaParts.join(" · ") || "",
                  desc: markerSummary || descriptionText || metaParts.join(" · ") || "",
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

      const sourcePoints = effectivePoints.length ? effectivePoints : TEST_POINTS;
      const hydratedPoints = sourcePoints.map((point, idx) => {
        const base = { ...point };
        const resolvedTitle =
          (typeof base.title === "string" && base.title.trim()) ||
          (typeof base.name === "string" && base.name.trim()) ||
          `Точка ${idx + 1}`;
        base.title = resolvedTitle;
        if (!base.name) {
          base.name = resolvedTitle;
        }

        const descriptionRaw =
          typeof base.description === "string" ? base.description.trim() : "";
        const descRaw = typeof base.desc === "string" ? base.desc.trim() : "";
        if (descriptionRaw) {
          base.description = descriptionRaw;
        } else if (descRaw) {
          base.description = descRaw;
        } else {
          base.description = "";
        }

        if (!descRaw) {
          base.desc = base.description || "";
        } else {
          base.desc = descRaw;
        }

        if (typeof base.metaSummary !== "string") {
          base.metaSummary = "";
        }

        return base;
      });

      appState.points = hydratedPoints;
      mapApi.setMarkers(appState.points);

      const fitPoints = [...appState.points];
      if (appState.origin) {
        fitPoints.push({ lat: appState.origin.lat, lon: appState.origin.lon });
      } else if (appState.userLocation) {
        fitPoints.push(appState.userLocation);
      }
      if (fitPoints.length) {
        mapApi.fitTo(fitPoints);
      }

      const routePoints = appState.origin
        ? [{ lat: appState.origin.lat, lon: appState.origin.lon }, ...appState.points]
        : [...appState.points];

      if (routePoints.length >= 2) {
        const route = await mapApi.buildPedestrianRoute(routePoints);
        appState.route = route;

        document.dispatchEvent(new CustomEvent("app:route-ready"));
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
    const pointsToFit = [...appState.points];
    if (appState.origin) {
      pointsToFit.push({ lat: appState.origin.lat, lon: appState.origin.lon });
    } else if (appState.userLocation) {
      pointsToFit.push(appState.userLocation);
    }
    mapApi.fitTo(pointsToFit);
    global.UI.scrollRouteList();

    // [MOBILE] Раскрываем список на мобиле + событие
    if (global.MobileUI) global.MobileUI.expandSheet();
    document.dispatchEvent(new CustomEvent('app:view-route'));
  }

  function handlePickOrigin() {
    if (!mapApi || !mapApi.pickOriginOnMap) {
      global.UI.showToast("Карта ещё не готова", 2200);
      return;
    }
    mapApi.pickOriginOnMap();
  }

  async function handleUseGeolocationForOrigin() {
    await setOriginFromGeolocation({ silent: false, center: true });
  }

  function handleClearOrigin() {
    if (!appState.origin) {
      global.UI.showToast("Старт уже сброшен", 2000);
      return;
    }
    clearOrigin();
    global.UI.showToast("Стартовая точка сброшена", 2000);
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
      if (appState.origin) {
        mapApi.setOrigin({ lat: appState.origin.lat, lon: appState.origin.lon });
      }
      if (appState.userLocation && appState.origin?.source === "geolocation") {
        mapApi.setUserLocation(appState.userLocation, { center: false });
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
    global.UI.updateOriginIndicator(appState.origin);

    // [MOBILE] Инициализируем мобильные улучшения
    if (global.MobileUI) {
      global.MobileUI.init();

      // Необязательный мост: отправлять тосты через MobileUI, чтобы они
      // попадали в единый стек и аккуратно располагались под safe-area.
      if (global.UI && typeof global.UI.showToast === 'function') {
        global.UI.showToast = (m, ms) => global.MobileUI.showToast(m, ms);
      }
    }

    document.addEventListener("map:origin-changed", (event) => {
      const detail = event.detail || {};
      const lat = Number(detail.lat);
      const lon = Number(detail.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        setOrigin({ lat, lon, source: "map" }, { updateMap: false, toast: false });
      }
    });

    global.UI.init({
      onBuildRoute: handleBuildRoute,
      onExplain: handleExplain,
      onViewRoute: handleViewRoute,
      onPickOrigin: handlePickOrigin,
      onUseGeolocation: handleUseGeolocationForOrigin,
      onClearOrigin: handleClearOrigin,
      onPreferencesChange: handlePreferencesChange,
      onChatOpen: () => {
        // Placeholder for future chat integration
      },
    });
  }

  document.addEventListener("DOMContentLoaded", boot);
})(window);
