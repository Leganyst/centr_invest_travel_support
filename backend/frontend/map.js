(function (global) {
  "use strict";

  const DEFAULT_CENTER = [39.7203, 47.2221];
  const DEFAULT_ZOOM = 12.5;
  const EARTH_RADIUS = 6371000;

  let mapInstance = null;
  let markerInstances = [];
  let polyline = null;
  let directionsController = null;
  let mapApiKey = null;
  let directionsApiKey = null;
  let userLocationMarker = null;
  let userAccuracyCircle = null;

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

  function ensureMapInstance() {
    if (!mapInstance) {
      throw new Error("Map is not initialized yet");
    }
  }

  function logError(scope, error) {
    const payload = error instanceof Error ? error.message : String(error);
    console.error(`[Map] ${scope} failed: ${payload}`);
  }

  async function ensureDirections() {
    if (!mapInstance) {
      return null;
    }
    if (!global.mapgl || typeof global.mapgl.Directions !== "function") {
      console.warn("[Map] MapGL Directions plugin is not available, using fallback route");
      return null;
    }
    if (!directionsController) {
      try {
        directionsController = new global.mapgl.Directions(mapInstance, {
          directionsApiKey,
        });
      } catch (error) {
        logError("Directions init", error);
        directionsController = null;
        return null;
      }
    }
    return directionsController;
  }

  function normalizeGeometry(geometry) {
    if (!geometry) {
      return null;
    }
    if (Array.isArray(geometry)) {
      if (geometry.length === 2 && typeof geometry[0] === "number" && typeof geometry[1] === "number") {
        return [geometry];
      }
      if (geometry.length && typeof geometry[0][0] === "number" && typeof geometry[0][1] === "number") {
        return geometry;
      }
      const flattened = geometry
        .map((part) => normalizeGeometry(part))
        .filter((part) => Array.isArray(part))
        .flat();
      return flattened.length ? flattened : null;
    }
    if (typeof geometry === "object") {
      if (geometry.type === "Feature") {
        return normalizeGeometry(geometry.geometry);
      }
      if (geometry.type === "FeatureCollection" && Array.isArray(geometry.features)) {
        const collected = geometry.features
          .map((feature) => normalizeGeometry(feature))
          .filter((part) => Array.isArray(part));
        const flattened = collected.flat();
        return flattened.length ? flattened : null;
      }
      if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
        return normalizeGeometry(geometry.coordinates);
      }
      if (geometry.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
        const flattened = geometry.coordinates
          .map((part) => normalizeGeometry(part))
          .filter((part) => Array.isArray(part))
          .flat();
        return flattened.length ? flattened : null;
      }
      if (Array.isArray(geometry.coordinates)) {
        return normalizeGeometry(geometry.coordinates);
      }
      if (Array.isArray(geometry.points)) {
        return normalizeGeometry(geometry.points);
      }
      if (Array.isArray(geometry.geometries)) {
        return normalizeGeometry(geometry.geometries);
      }
    }
    return null;
  }

  function drawPolyline(path) {
    ensureMapInstance();
    if (!global.mapgl) {
      return;
    }
    try {
      if (polyline) {
        polyline.destroy();
        polyline = null;
      }
      polyline = new global.mapgl.Polyline(mapInstance, {
        coordinates: path,
        strokeColor: "#1f6feb",
        strokeWidth: 4,
        strokeOpacity: 0.85,
      });
    } catch (error) {
      logError("Polyline", error);
    }
  }

  function fallbackRoute(points) {
    const coordinates = points.map((p) => [p.lon, p.lat]);
    const legs = [];
    let totalDistance = 0;
    for (let i = 0; i < coordinates.length - 1; i += 1) {
      const start = coordinates[i];
      const end = coordinates[i + 1];
      const distance = haversineDistance(start, end);
      totalDistance += distance;
      legs.push({
        from: points[i],
        to: points[i + 1],
        distance,
        duration: distance / 70, // meters per second at ~4 km/h
      });
    }
    drawPolyline(coordinates);
    return {
      legs,
      distance: totalDistance,
      duration: totalDistance / 70,
      usedFallback: true,
    };
  }

  async function buildPedestrianRoute(points) {
    ensureMapInstance();
    if (!Array.isArray(points) || points.length < 2) {
      return {
        legs: [],
        distance: 0,
        duration: 0,
        usedFallback: true,
      };
    }

    const pathCoordinates = points.map((p) => [p.lon, p.lat]);

    try {
      const controller = await ensureDirections();
      if (!controller) {
        return fallbackRoute(points);
      }

      if (typeof controller.pedestrianRoute !== "function") {
        console.warn("[Map] Directions controller has no pedestrianRoute() method, using fallback");
        return fallbackRoute(points);
      }

      if (typeof controller.clear === "function") {
        controller.clear();
      }

      const response = await controller.pedestrianRoute({
        points: pathCoordinates,
      });

      const route =
        response?.route ||
        response?.result?.route ||
        (Array.isArray(response?.routes) ? response.routes[0] : null) ||
        response;

      const geometryCandidate =
        route?.geometry ||
        route?.paths ||
        route?.polyline ||
        response?.geometry ||
        response?.geojson ||
        response?.result?.geometry ||
        response?.result?.geojson;

      const routeGeometry = normalizeGeometry(geometryCandidate);
      const routeLegs = route?.legs || route?.segments || response?.result?.legs;

      if (!routeGeometry) {
        console.warn("[Map] Directions response has no geometry, using fallback");
        return fallbackRoute(points);
      }

      drawPolyline(routeGeometry);

      const legs = Array.isArray(routeLegs)
        ? routeLegs.map((leg, idx) => ({
            from: points[idx],
            to: points[idx + 1],
            distance: leg.distance ?? leg?.distanceMeters ?? 0,
            duration: leg.duration ?? leg?.durationSeconds ?? 0,
          }))
        : [];

      const totalDistance = route?.distance ?? route?.distanceMeters ?? legs.reduce((acc, leg) => acc + (leg.distance || 0), 0);
      const totalDuration = route?.duration ?? route?.durationSeconds ?? legs.reduce((acc, leg) => acc + (leg.duration || 0), 0);

      return {
        legs,
        distance: totalDistance,
        duration: totalDuration,
        usedFallback: false,
      };
    } catch (error) {
      logError("Directions", error);
      return fallbackRoute(points);
    }
  }

  function addMarker({ lon, lat, title, desc }) {
    ensureMapInstance();
    if (!global.mapgl) {
      return null;
    }

    try {
      const marker = new global.mapgl.Marker(mapInstance, {
        coordinates: [lon, lat],
        icon: "default",
      });

      marker.setLabel({
        text: title,
        textColor: "#0f172a",
        offset: [0, -24],
        fontSize: 14,
      });

      marker.on("click", () => {
        const message = desc ? `${title}: ${desc}` : title;
        if (global.UI?.showToast) {
          global.UI.showToast(message, 4200);
        } else {
          global.alert(message);
        }
      });

      markerInstances.push({ marker });
      return marker;
    } catch (error) {
      logError("Marker", error);
      return null;
    }
  }

  function clearMarkers() {
    markerInstances.forEach(({ marker, popup }) => {
      try {
        if (popup && typeof popup.destroy === "function") {
          popup.destroy();
        }
        marker.destroy();
      } catch (error) {
        logError("Marker cleanup", error);
      }
    });
    markerInstances = [];
  }

  function clearUserLocationMarker() {
    if (userLocationMarker) {
      try {
        userLocationMarker.destroy();
      } catch (error) {
        logError("User location cleanup", error);
      }
      userLocationMarker = null;
    }
    if (userAccuracyCircle) {
      try {
        userAccuracyCircle.destroy();
      } catch (error) {
        logError("User accuracy cleanup", error);
      }
      userAccuracyCircle = null;
    }
  }

  function setUserLocation(point, options = {}) {
    if (!point || point.lon == null || point.lat == null) {
      return;
    }
    ensureMapInstance();
    clearUserLocationMarker();
    const coordinates = [point.lon, point.lat];

    try {
      if (point.accuracy && typeof global.mapgl.CircleMarker === "function") {
        userAccuracyCircle = new global.mapgl.CircleMarker(mapInstance, {
          coordinates,
          radius: Math.max(point.accuracy, 25),
          color: "rgba(31, 111, 235, 0.12)",
          strokeColor: "rgba(31, 111, 235, 0.35)",
          strokeWidth: 2,
        });
      }
    } catch (error) {
      logError("User location accuracy", error);
      if (userAccuracyCircle) {
        try {
          userAccuracyCircle.destroy();
        } catch (_) {
          /* ignore */
        }
        userAccuracyCircle = null;
      }
    }

    try {
      userLocationMarker = new global.mapgl.Marker(mapInstance, {
        coordinates,
        icon: "default",
      });
    } catch (error) {
      logError("User location marker", error);
    }

    if (options.center) {
      setCenter(coordinates);
    }
  }

  function setMarkers(points) {
    clearMarkers();
    points.forEach((point) => addMarker(point));
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
    if (!points.length) {
      return;
    }
    try {
      const longitudes = points.map((p) => p.lon);
      const latitudes = points.map((p) => p.lat);
      if (typeof mapInstance.setBounds === "function") {
        const bounds = [
          [Math.min(...longitudes), Math.min(...latitudes)],
          [Math.max(...longitudes), Math.max(...latitudes)],
        ];
        mapInstance.setBounds(bounds, { padding: 48 });
      } else {
        setCenter([points[0].lon, points[0].lat]);
      }
    } catch (error) {
      logError("fitTo", error);
      setCenter([points[0].lon, points[0].lat]);
    }
  }

  function initMap({ mapKey, directionsKey }) {
    if (!global.mapgl || typeof global.mapgl.Map !== "function") {
      console.error("[Map] MapGL library is missing");
      throw new Error("MapGL script is not loaded");
    }
    mapApiKey = mapKey;
    directionsApiKey = directionsKey || mapKey;
    const mapElement = document.getElementById("map");
    if (mapElement) {
      mapElement.classList.remove("map-placeholder");
      if (mapElement.childElementCount === 0) {
        mapElement.textContent = "";
      }
    }

    mapInstance = new global.mapgl.Map("map", {
      key: mapApiKey,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: true,
      trafficControl: false,
    });

    mapInstance.on("idle", () => {
      if (mapElement) {
        mapElement.classList.remove("map-placeholder");
      }
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

  global.FrontendMap = {
    initMap,
  };
})(window);
