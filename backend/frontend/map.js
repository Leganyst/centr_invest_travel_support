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
  let originLonLat = null; // [lon, lat]
  let originMarker = null;
  let originControl = null;
  let originControlButton = null;
  let isPickingOrigin = false;
  let originCursorToken = null;

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

  function addMarker({ lon, lat, title, desc, idx }) {
    ensureMapInstance();
    if (!global.mapgl) return null;

    const lonlat = toLonLat({ lon, lat });
    if (!lonlat) return null;

    const safeTitle = String(title || "Точка");
    const labelText = (typeof idx === "number" && Number.isFinite(idx))
      ? `${idx}. ${safeTitle}`
      : safeTitle;

    try {
      const marker = new global.mapgl.Marker(mapInstance, {
        coordinates: lonlat,
        label: {
          text: labelText,               // <-- метка сразу с номером
          relativeAnchor: [0.5, 1.15],
          offset: [0, -6],
        },
      });

      // сохраним мету, пригодится для фокуса/клика из списка
      marker._meta = { idx, title: safeTitle, desc: String(desc || ""), lonlat };

      marker.on("click", () => {
        const n = marker._meta?.idx;
        const head = (Number.isFinite(n) ? `#${n} ` : "") + (marker._meta?.title || "Точка");
        const message = marker._meta?.desc
          ? `${head}: ${marker._meta.desc}`
          : head;
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

  function clearOriginMarker() {
    if (originMarker) {
      try { originMarker.destroy(); } catch (e) { logError("Origin marker", e); }
      originMarker = null;
    }
    originLonLat = null;
    setOriginPickingState(false);
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

  function setOriginPoint(point, options = {}) {
    if (!point) return;
    ensureMapInstance();

    const lonlat = Array.isArray(point) ? point : toLonLat(point);
    if (!lonlat) return;

    originLonLat = lonlat;
    setOriginPickingState(false);
    try {
      if (!originMarker) {
        originMarker = new global.mapgl.Marker(mapInstance, {
          coordinates: lonlat,
          label: {
            text: "Старт",
            relativeAnchor: [0.5, 1.2],
            offset: [0, -8],
          },
        });
      } else {
        originMarker.setCoordinates(lonlat);
      }
      originMarker._meta = { lonlat };
    } catch (error) {
      logError("Origin marker", error);
    }

    if (options.center) {
      setCenter(lonlat);
    }

    if (typeof options.onSet === "function") {
      try { options.onSet(lonlat); } catch (e) { logError("Origin callback", e); }
    }
  }

  function getOriginPoint() {
    if (!originLonLat) return null;
    return { lon: originLonLat[0], lat: originLonLat[1] };
  }

  function setPickingCursor(enabled) {
    if (!mapInstance || !mapInstance.getContainer) return;
    const container = mapInstance.getContainer();
    if (!container) return;

    if (enabled) {
      originCursorToken = container.style.cursor;
      container.style.cursor = "crosshair";
    } else {
      if (originCursorToken != null) {
        container.style.cursor = originCursorToken;
      } else {
        container.style.cursor = "";
      }
      originCursorToken = null;
    }
  }

  function setOriginPickingState(active) {
    isPickingOrigin = active;
    setPickingCursor(active);
    if (originControlButton) {
      if (active) {
        originControlButton.classList.add("is-picking");
        originControlButton.textContent = "Кликните на карту…";
      } else {
        originControlButton.classList.remove("is-picking");
        originControlButton.textContent = "Выбрать старт";
      }
    }
  }

  function handleMapClickForOrigin(ev) {
    if (!isPickingOrigin || !ev || !ev.lngLat) return;
    setOriginPickingState(false);
    setOriginPoint(ev.lngLat, { center: false });
    if (global.UI?.showToast) {
      const lon = ev.lngLat[0].toFixed(5);
      const lat = ev.lngLat[1].toFixed(5);
      global.UI.showToast(`Стартовая точка: ${lat}, ${lon}`, 2400);
    }
    document.dispatchEvent(new CustomEvent("map:origin-changed", {
      detail: { lon: ev.lngLat[0], lat: ev.lngLat[1] },
    }));
  }

  function enterOriginPicking() {
    ensureMapInstance();
    setOriginPickingState(true);
  }

  function ensureOriginControl() {
    if (!mapInstance || !global.mapgl || typeof global.mapgl.Control !== "function") return;
    if (originControl) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "map-control map-control--origin";
    btn.textContent = "Выбрать старт";
    btn.addEventListener("click", () => {
      enterOriginPicking();
      if (global.UI?.showToast) {
        global.UI.showToast("Кликните на карту, чтобы выбрать старт маршрута", 2600);
      }
    });

    originControlButton = btn;
    originControl = new global.mapgl.Control(mapInstance, btn, { position: "topLeft" });
  }

  function setMarkers(pointsOrStops) {
    clearMarkers();
    const items = Array.isArray(pointsOrStops) ? pointsOrStops : [];
    let idx = 1;

    for (const it of items) {
      // поддерживаем оба формата
      const isStop = it && (typeof it.name === "string" || typeof it.description === "string");
      const title = isStop ? it.name : it.title;
      const desc  = isStop ? it.description : it.desc;

      addMarker({
        lon: it.lon,
        lat: it.lat,
        title,
        desc,
        idx,           // <--- синхронизированная нумерация
      });

      idx += 1;
    }
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
/* ------------------------ UI list (stops) ------------------------ */
function _escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function focusMarker(idx, options = {}) {
  ensureMapInstance();
  const { pan = true, openToast = false } = options;
  const m = markerInstances[idx - 1]; // idx у нас 1..N
  if (!m) return;

  try {
    const coords = m.getCoordinates ? m.getCoordinates() : (m._meta?.lonlat);
    if (pan && coords) {
      setCenter(coords);
    }
    if (openToast) {
      const n = m._meta?.idx;
      const head = (Number.isFinite(n) ? `#${n} ` : "") + (m._meta?.title || "Точка");
      const message = m._meta?.desc ? `${head}: ${m._meta.desc}` : head;
      if (global.UI?.showToast) global.UI.showToast(message, 3600);
    }
  } catch (e) {
    logError("focusMarker", e);
  }
}

/**
 * Рендерит список остановок с той же нумерацией, что и на карте.
 * @param {string|HTMLElement} containerOrId - контейнер списка
 * @param {Array} stops - stops из /plan (порядок уже отсортирован бэком)
 */
function renderStopList(containerOrId, stops = []) {
  const el = typeof containerOrId === "string"
    ? document.getElementById(containerOrId)
    : containerOrId;

  if (!el) return;

  const parts = [];
  parts.push('<ol class="stop-list">');
  for (let i = 0; i < stops.length; i += 1) {
    const n = i + 1;
    const s = stops[i] || {};
    const name = _escapeHtml(s.name || `Точка ${n}`);
    const desc = _escapeHtml(s.description || "");
    parts.push(`
      <li class="stop-item" data-idx="${n}">
        <div class="stop-head">
          <span class="stop-num">${n}</span>
          <span class="stop-title">${name}</span>
        </div>
        ${desc ? `<div class="stop-desc">${desc}</div>` : ""}
      </li>
    `);
  }
  parts.push("</ol>");

  el.innerHTML = parts.join("");

  // клики по пунктам — фокусируем соответствующий маркер
  el.querySelectorAll(".stop-item").forEach((li) => {
    li.addEventListener("click", () => {
      const idx = Number(li.getAttribute("data-idx"));
      focusMarker(idx, { pan: true, openToast: true });
    });
  });
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

    mapInstance.on("click", handleMapClickForOrigin);
    mapInstance.on("idle", () => {
      if (mapElement) mapElement.classList.remove("map-placeholder");
    });

    ensureOriginControl();

    return {
      setCenter,
      addMarker,
      setMarkers,        // теперь с нумерацией
      clearMarkers,
      setUserLocation,
      fitTo,
      buildPedestrianRoute,
      // новое:
      renderStopList,
      focusMarker,
      setOrigin: setOriginPoint,
      getOrigin: getOriginPoint,
      clearOrigin: clearOriginMarker,
      pickOriginOnMap: () => {
        enterOriginPicking();
        if (global.UI?.showToast) {
          global.UI.showToast("Кликните на карту, чтобы выбрать старт маршрута", 2600);
        }
      },
    };

  }

  global.FrontendMap = { initMap };
})(window);
