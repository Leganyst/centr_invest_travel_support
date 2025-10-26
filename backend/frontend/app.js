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
    prefs: { tags: [], budget: "low", pace: "normal" },
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

  function updateRouteList() {
    global.UI.renderRouteList(appState.points, appState.route);
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
        mapApi.setUserLocation(appState.userLocation, { center: false });
      }

      global.UI.showToast("Строим пеший маршрут…", 1800);
      appState.points = TEST_POINTS;
      mapApi.setMarkers(appState.points);
      const pointsToFit = appState.userLocation
        ? [...appState.points, appState.userLocation]
        : [...appState.points];
      mapApi.fitTo(pointsToFit);
      const route = await mapApi.buildPedestrianRoute(appState.points);
      appState.route = route;
      updateRouteList();

      if (route.usedFallback) {
        global.UI.showToast("Не удалось построить точный маршрут, показан приблизительный");
      } else {
        global.UI.showToast("Маршрут построен");
      }
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
    global.UI.setStateGetter(() => appState);
    global.UI.renderRouteList(appState.points, appState.route);
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
