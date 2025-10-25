import { useEffect, useRef } from "react";
import { loadMapglScript } from "../utils/mapgl";
import type { Stop, StartPoint } from "../types";

interface MapViewProps {
  mapKey: string;
  stops: Stop[];
  startPoint: StartPoint;
  selectedIndex: number | null;
  onMarkerSelect: (index: number) => void;
  onMapError: (message: string) => void;
}

type MapglInstance = any;

const DEFAULT_ZOOM = 13;

export function MapView({
  mapKey,
  stops,
  startPoint,
  selectedIndex,
  onMarkerSelect,
  onMapError
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapglInstance | null>(null);
  const markersRef = useRef<MapglInstance[]>([]);
  const polylineRef = useRef<MapglInstance | null>(null);
  const startMarkerRef = useRef<MapglInstance | null>(null);
  const currentKeyRef = useRef<string>("");

  useEffect(() => {
    let cancelled = false;

    loadMapglScript()
      .then((mapgl) => {
        if (cancelled || !containerRef.current) {
          return;
        }

        const candidateKey = mapKey?.trim() || "demo";
        if (mapRef.current) {
          if (currentKeyRef.current !== candidateKey) {
            mapRef.current?.destroy?.();
            mapRef.current = null;
          } else {
            updateMap(mapgl);
            return;
          }
        }

        try {
          mapRef.current = new mapgl.Map(containerRef.current, {
            key: candidateKey,
            center: [startPoint.lon, startPoint.lat],
            zoom: DEFAULT_ZOOM
          });
          currentKeyRef.current = candidateKey;
        } catch (error) {
          if (candidateKey !== "demo") {
            try {
              mapRef.current = new mapgl.Map(containerRef.current, {
                key: "demo",
                center: [startPoint.lon, startPoint.lat],
                zoom: DEFAULT_ZOOM
              });
              currentKeyRef.current = "demo";
              onMapError("MapGL ключ недействителен — используется демо-режим.");
            } catch (fallbackError) {
              console.error("[mapgl] fallback init failed", fallbackError);
              onMapError("Не удалось инициализировать карту 2ГИС.");
              return;
            }
          } else {
            console.error("[mapgl] init failed", error);
            onMapError("Не удалось инициализировать карту 2ГИС.");
            return;
          }
        }

        updateMap(mapgl);
      })
      .catch((error) => {
        console.error("[mapgl] script load failed", error);
        onMapError("Не удалось загрузить библиотеку карты 2ГИС.");
      });

    return () => {
      cancelled = true;
      markersRef.current.forEach((marker) => marker?.destroy?.());
      markersRef.current = [];
      polylineRef.current?.destroy?.();
      polylineRef.current = null;
      startMarkerRef.current?.destroy?.();
      startMarkerRef.current = null;
      mapRef.current?.destroy?.();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapKey]);

  useEffect(() => {
    if (!mapRef.current || !window.mapgl) {
      return;
    }
    updateMap(window.mapgl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, startPoint, selectedIndex]);

  function updateMap(mapgl: any) {
    if (!mapRef.current) {
      return;
    }
    renderStartMarker(mapgl);
    renderRoute(mapgl);
    highlightMarker(selectedIndex);
  }

  function renderStartMarker(mapgl: any) {
    if (!mapRef.current) {
      return;
    }
    startMarkerRef.current?.destroy?.();
    startMarkerRef.current = null;

    const hasAccuracy = typeof startPoint.accuracy_m === "number" && startPoint.accuracy_m > 0;
    const clampedAccuracy = hasAccuracy
      ? Math.min(Math.max((startPoint.accuracy_m ?? 0) / 1.5, 32), 140)
      : 0;

    const html =
      startPoint.source === "user"
        ? hasAccuracy
          ? `<div class="map-user-accuracy" style="width:${clampedAccuracy}px;height:${clampedAccuracy}px"><span class="map-user-marker"></span></div>`
          : '<div class="map-user-marker"></div>'
        : '<div class="map-start-marker map-start-marker--city"></div>';

    startMarkerRef.current = new mapgl.HtmlMarker(mapRef.current, {
      coordinates: [startPoint.lon, startPoint.lat],
      html
    });

    if (!stops.length) {
      mapRef.current.setCenter([startPoint.lon, startPoint.lat]);
      mapRef.current.setZoom(DEFAULT_ZOOM);
    }
  }

  function renderRoute(mapgl: any) {
    if (!mapRef.current) {
      return;
    }

    markersRef.current.forEach((marker) => marker?.destroy?.());
    markersRef.current = [];
    polylineRef.current?.destroy?.();
    polylineRef.current = null;

    if (!stops.length) {
      return;
    }

    const coordinates = stops.map((stop) => [stop.lon, stop.lat]);
    polylineRef.current = new mapgl.Polyline(mapRef.current, {
      coordinates,
      color: "#2563eb",
      width: 4
    });

    stops.forEach((stop, index) => {
      const marker = new mapgl.HtmlMarker(mapRef.current, {
        coordinates: [stop.lon, stop.lat],
        html: `<button class="map-marker" data-stop="${index}">${index + 1}</button>`
      });
      const element = marker.getElement?.();
      if (element) {
        element.addEventListener("click", () => onMarkerSelect(index));
      }
      markersRef.current.push(marker);
    });

    let minLat = stops[0].lat;
    let maxLat = stops[0].lat;
    let minLon = stops[0].lon;
    let maxLon = stops[0].lon;

    stops.forEach((stop) => {
      minLat = Math.min(minLat, stop.lat);
      maxLat = Math.max(maxLat, stop.lat);
      minLon = Math.min(minLon, stop.lon);
      maxLon = Math.max(maxLon, stop.lon);
    });

    minLat = Math.min(minLat, startPoint.lat);
    maxLat = Math.max(maxLat, startPoint.lat);
    minLon = Math.min(minLon, startPoint.lon);
    maxLon = Math.max(maxLon, startPoint.lon);

    try {
      mapRef.current.fitBounds(
        [
          [minLon, minLat],
          [maxLon, maxLat]
        ],
        { padding: 32 }
      );
    } catch (error) {
      console.debug("[mapgl] fitBounds failed", error);
    }
  }

  function highlightMarker(index: number | null) {
    markersRef.current.forEach((marker) => {
      const el = marker.getElement?.();
      if (!el) return;
      const markerIndex = Number(el.dataset.stop);
      if (Number.isFinite(markerIndex)) {
        if (markerIndex === index) {
          el.classList.add("map-marker--active");
        } else {
          el.classList.remove("map-marker--active");
        }
      }
    });
    if (
      index !== null &&
      stops[index] &&
      mapRef.current &&
      typeof mapRef.current.setCenter === "function"
    ) {
      mapRef.current.setCenter([stops[index].lon, stops[index].lat]);
      if (typeof mapRef.current.setZoom === "function") {
        mapRef.current.setZoom(14);
      }
    }
  }

  return <div ref={containerRef} className="map-container" role="img" aria-label="Карта маршрута" />;
}
