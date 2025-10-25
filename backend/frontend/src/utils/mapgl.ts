let scriptPromise: Promise<typeof window.mapgl> | null = null;

declare global {
  interface Window {
    mapgl?: any;
  }
}

export function loadMapglScript(): Promise<typeof window.mapgl> {
  if (window.mapgl) {
    return Promise.resolve(window.mapgl);
  }
  if (scriptPromise) {
    return scriptPromise;
  }

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://mapgl.2gis.com/api/js/v1";
    script.async = true;
    script.onload = () => {
      if (window.mapgl) {
        resolve(window.mapgl);
      } else {
        reject(new Error("MapGL script loaded but window.mapgl is undefined"));
      }
    };
    script.onerror = (event) => {
      reject(new Error(`MapGL script failed to load ${(event as ErrorEvent).message ?? ""}`));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}
