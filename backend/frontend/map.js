(function (global) {
  "use strict";

  // Ростов-на-Дону
  const DEFAULT_CENTER = [39.7203, 47.2221]; // [lon, lat]
  const DEFAULT_ZOOM = 12.5;
  const EARTH_RADIUS = 6371000;

  let mapInstance = null;
  let markerInstances = [];
  let fallbackPolyline = null; // рисуем только в fallback
  let directionsController = null;
  let mapApiKey = null;
  let directionsApiKey = null;
  let userLocationMarker = null;
  let userAccuracyCircle = null;

  /* ------------------------ utils ------------------------ */
  function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  function toLonLat(p) {
    if (!p) return null;
    const lon = Number(p.lon);
    const lat = Number(p.lat);
    if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return [lon, lat]; // ВАЖНО: формат [lon, lat] — как в 2ГИС MapGL
  }

  function haversineDistance(a, b) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function logError(scope, error) {
    const payload = error instanceof Error ? error.message : String(error);
    console.error(`[Map] ${scope} failed: ${payload}`);
  }

  /* ------------------------ map primitives ------------------------ */
  function ensureMapInstance() {
    if (!mapInstance) {
      throw new Error("Map is not initialized yet");
    }
  }

  function clearFallbackPolyline() {
    if (fallbackPolyline) {
      try { fallbackPolyline.destroy(); } catch (_) {}
      fallbackPolyline = null;
    }
  }

  function drawFallbackPolyline(pathLonLat) {
    ensureMapInstance();
    if (!global.mapgl) return;
    clearFallbackPolyline();
    try {
      fallbackPolyline = new global.mapgl.Polyline(mapInstance, {
        coordinates: pathLonLat,
        strokeColor: "#1f6feb",
        strokeWidth: 4,
        strokeOpacity: 0.85,
      });
    } catch (error) {
      logError("Fallback polyline", error);
    }
  }

  function addMarker({ lon, lat, title, desc }) {
    ensureMapInstance();
    if (!global.mapgl) return null;

    const lonlat = toLonLat({ lon, lat });
    if (!lonlat) return null;

    try {
      // Подписи у маркеров — через опцию label (Marker with text)
      const marker = new global.mapgl.Marker(mapInstance, {
        coordinates: lonlat,
        label: {
          text: String(title || "Точка"),
          // расположение подписи относительно иконки
          relativeAnchor: [0.5, 1.15],
          offset: [0, -6],
        },
      });

      marker.on("click", () => {
        const message = desc ? `${title}: ${desc}` : String(title || "Точка");
        if (global.UI?.showToast) {
          global.UI.showToast(message, 4200);
        } else {
          global.alert(message);
        }
      });

      markerInstances.push(marker);
      return marker;
    } catch (error) {
      logError("Marker", error);
      return null;
    }
  }

  function clearMarkers() {
    for (const marker of markerInstances) {
      try { marker.destroy(); } catch (e) { logError("Marker destroy", e); }
    }
    markerInstances = [];
  }

  function clearUserLocationMarker() {
    if (userLocationMarker) {
      try { userLocationMarker.destroy(); } catch (e) { logError("User marker", e); }
      userLocationMarker = null;
    }
    if (userAccuracyCircle) {
      try { userAccuracyCircle.destroy(); } catch (e) { logError("Accuracy circle", e); }
      userAccuracyCircle = null;
    }
  }

  function setUserLocation(point, options = {}) {
    if (!point || point.lon == null || point.lat == null) return;
    ensureMapInstance();
    clearUserLocationMarker();

    const lonlat = toLonLat(point);
    if (!lonlat) return;

    try {
      const acc = Number(point.accuracy) || 0;
      // Круг точности: предпочитаем метрический Circle; если недоступен — CircleMarker (пиксели)
      if (acc > 0) {
        if (typeof global.mapgl.Circle === "function") {
          userAccuracyCircle = new global.mapgl.Circle(mapInstance, {
            coordinates: lonlat,
            radius: Math.max(acc, 25), // ≥25 м, чтобы круг был виден
            color: "rgba(31, 111, 235, 0.12)",
            strokeColor: "rgba(31, 111, 235, 0.35)",
            strokeWidth: 2,
          });
        } else if (typeof global.mapgl.CircleMarker === "function") {
          userAccuracyCircle = new global.mapgl.CircleMarker(mapInstance, {
            coordinates: lonlat,
            radius: 24,
            color: "rgba(31, 111, 235, 0.12)",
            strokeColor: "rgba(31, 111, 235, 0.35)",
            strokeWidth: 2,
          });
        }
      }
    } catch (error) {
      logError("User location accuracy", error);
      if (userAccuracyCircle) {
        try { userAccuracyCircle.destroy(); } catch (_) {}
        userAccuracyCircle = null;
      }
    }

    try {
      userLocationMarker = new global.mapgl.Marker(mapInstance, {
        coordinates: lonlat,
        label: {
          text: "Вы здесь",
          relativeAnchor: [0.5, 1.15],
          offset: [0, -6],
        },
      });
    } catch (error) {
      logError("User location marker", error);
    }

    if (options.center) {
      setCenter(lonlat);
    }
  }

  function setMarkers(points) {
    clearMarkers();
    for (const p of points) addMarker(p);
  }

  function setCenter([lon, lat]) {
    ensureMapInstance();
    try {
      mapInstance.setCenter([lon, lat]);
    } catch (error) {
      logError("setCenter", error);
    }
  }

  function fitTo(points) {
    ensureMapInstance();
    if (!points || !points.length) return;

    try {
      const lonlats = [];
      for (const p of points) {
        const ll = Array.isArray(p) ? p : toLonLat(p);
        if (ll) lonlats.push(ll);
      }
      if (!lonlats.length) return;

      const lons = lonlats.map(([x]) => x);
      const lats = lonlats.map(([, y]) => y);
      const bounds = [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ];

      if (typeof mapInstance.setBounds === "function") {
        mapInstance.setBounds(bounds, { padding: 48 });
      } else {
        const center = [
          (bounds[0][0] + bounds[1][0]) / 2,
          (bounds[0][1] + bounds[1][1]) / 2,
        ];
        mapInstance.setCenter(center);
        mapInstance.setZoom(DEFAULT_ZOOM);
      }
    } catch (error) {
      logError("fitTo", error);
    }
  }

  /* ------------------------ Directions (2ГИС) ------------------------ */
  async function ensureDirections() {
    if (!mapInstance) return null;
    if (!global.mapgl || typeof global.mapgl.Directions !== "function") {
      console.warn("[Map] MapGL Directions plugin is not available, using fallback route");
      return null;
    }
    if (!directionsController) {
      try {
        directionsController = new global.mapgl.Directions(mapInstance, {
          directionsApiKey, // Ключ РОУТИНГА — обязателен для плагина
        });
      } catch (error) {
        logError("Directions init", error);
        directionsController = null;
        return null;
      }
    }
    return directionsController;
  }

  function fallbackRoute(points) {
    const coords = [];
    for (const p of points) {
      const ll = toLonLat(p);
      if (ll) coords.push(ll);
    }
    if (coords.length < 2) {
      return { legs: [], distance: 0, duration: 0, usedFallback: true };
    }

    const legs = [];
    let totalDistance = 0;
    for (let i = 0; i < coords.length - 1; i += 1) {
      const start = coords[i];
      const end = coords[i + 1];
      const distance = haversineDistance(start, end);
      totalDistance += distance;
      legs.push({
        from: points[i],
        to: points[i + 1],
        distance,
        duration: distance / 1.1, // ~1.1 м/с (~4 км/ч)
      });
    }

    drawFallbackPolyline(coords);
    fitTo(coords);

    return {
      legs,
      distance: totalDistance,
      duration: totalDistance / 1.1,
      usedFallback: true,
    };
  }

  async function buildPedestrianRoute(points) {
    ensureMapInstance();
    clearFallbackPolyline(); // если ранее строили fallback

    if (!Array.isArray(points) || points.length < 2) {
      return { legs: [], distance: 0, duration: 0, usedFallback: true };
    }

    // Валидируем и ограничиваем до 10 точек (лимит плагина)
    const coords = [];
    for (const p of points) {
      const ll = toLonLat(p);
      if (ll) coords.push(ll);
      if (coords.length === 10) break;
    }
    if (coords.length < 2) return { legs: [], distance: 0, duration: 0, usedFallback: true };

    const controller = await ensureDirections();
    if (!controller || typeof controller.pedestrianRoute !== "function") {
      console.warn("[Map] Directions not available, fallback walking line");
      return fallbackRoute(points);
    }

    try {
      if (typeof controller.clear === "function") controller.clear();
      // Плагин Directions сам отрисует маршрут (main/substrate/halo)
      await controller.pedestrianRoute({ points: coords });
      fitTo(coords);
      // Метрики плагин может не возвращать — оставим null/0, UI показывает факт построения
      return { legs: [], distance: null, duration: null, usedFallback: false };
    } catch (error) {
      logError("Directions.pedestrianRoute", error);
      return fallbackRoute(points);
    }
  }

  /* ------------------------ init ------------------------ */
  function initMap({ mapKey, directionsKey }) {
    if (!global.mapgl || typeof global.mapgl.Map !== "function") {
      console.error("[Map] MapGL library is missing");
      throw new Error("MapGL script is not loaded");
    }

    mapApiKey = mapKey;
    directionsApiKey = directionsKey || mapKey; // допускаем единый ключ, если в кабинете разрешено

    const mapElement = document.getElementById("map");
    if (mapElement) {
      mapElement.classList.remove("map-placeholder");
      if (mapElement.childElementCount === 0) mapElement.textContent = "";
    }

    mapInstance = new global.mapgl.Map("map", {
      key: mapApiKey,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: true,
      trafficControl: false,
    });

    mapInstance.on("idle", () => {
      if (mapElement) mapElement.classList.remove("map-placeholder");
    });

    return {
      setCenter,
      addMarker,
      setMarkers,
      clearMarkers,
      setUserLocation,
      fitTo,
      buildPedestrianRoute,
    };
  }

  global.FrontendMap = { initMap };
})(window);
