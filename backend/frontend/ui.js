(function (global) {
  "use strict";

  const elements = {
    buildButton: document.getElementById("btn-build"),
    downloadIcsButton: document.getElementById("btn-download-ics"),
    explainButton: document.getElementById("btn-explain"),
    viewRouteButton: document.getElementById("btn-view-route"),
    preferencesButton: document.getElementById("btn-preferences"),
    chatButton: document.getElementById("btn-chat"),
    routeList: document.getElementById("route-list"),
    toast: document.getElementById("toast"),
    prefsModal: document.getElementById("prefs-modal"),
    chatModal: document.getElementById("chat-modal"),
    prefsForm: document.querySelector("#prefs-modal form"),
  };

  let toastTimer = null;
  let getState = () => ({
    points: [],
    route: null,
    prefs: { tags: [], budget: "low", pace: "normal" },
  });
  let handlers = {};

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatCoord(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? String(value) : "";
    }
    return value != null ? String(value) : "";
  }

  function escapeIcs(value) {
    return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  }

  function formatDateUtc(date) {
    return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  }

  function generateIcs(points) {
    if (!points.length) {
      return "";
    }
    const now = new Date();
    const start = new Date(now);
    start.setHours(10, 0, 0, 0);
    const durationMinutes = 60;

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//CentrInvest Travel Support//Route Planner//RU",
      "CALSCALE:GREGORIAN",
    ];

    points.forEach((point, index) => {
      const eventStart = new Date(start.getTime() + index * durationMinutes * 60 * 1000);
      const eventEnd = new Date(eventStart.getTime() + durationMinutes * 60 * 1000);
      lines.push(
        "BEGIN:VEVENT",
        `UID:${Date.now()}-${index}@centr-invest-demo`,
        `DTSTAMP:${formatDateUtc(now)}`,
        `DTSTART:${formatDateUtc(eventStart)}`,
        `DTEND:${formatDateUtc(eventEnd)}`,
        `SUMMARY:${escapeIcs(point.title || "Точка маршрута")}`,
        `LOCATION:${escapeIcs(point.desc || "")}`,
        "END:VEVENT",
      );
    });

    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
  }

  function downloadIcs() {
    const state = getState();
    if (!state.points.length) {
      global.alert("Постройте маршрут, чтобы сохранить календарь.");
      return;
    }
    const ics = generateIcs(state.points);
    if (!ics) {
      global.alert("Нет данных для сохранения маршрута.");
      return;
    }
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "itinerary.ics";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    console.log("[UI] ICS файл сформирован и отправлен на скачивание");
  }

  function getPrefsFromForm() {
    const formData = new FormData(elements.prefsForm);
    const tags = [];
    elements.prefsForm.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      if (checkbox.checked) {
        tags.push(checkbox.value);
      }
    });
    return {
      tags,
      budget: formData.get("budget") || "low",
      pace: formData.get("pace") || "normal",
    };
  }

  function showToast(message, timeout = 3200) {
    if (!elements.toast) {
      return;
    }
    elements.toast.textContent = message;
    elements.toast.classList.remove("hidden");
    elements.toast.classList.add("visible");
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = global.setTimeout(() => {
      elements.toast.classList.remove("visible");
      elements.toast.classList.add("hidden");
    }, timeout);
  }

  function renderRouteList(points, route) {
    const container = elements.routeList;
    if (!container) {
      return;
    }
    if (!points.length) {
      container.innerHTML = `<p class="route-meta">Пока маршрут не построен. Нажмите «Построить».</p>`;
      return;
    }
    const legs = route?.legs ?? [];
    container.innerHTML = points
      .map((point, index) => {
        const leg = legs[index - 1];
        const eta = leg?.duration ? Math.round(leg.duration / 60) : 0;
        return `
          <article class="route-item">
            <h3>${escapeHtml(point.title || `Точка ${index + 1}`)}</h3>
            <p>${escapeHtml(point.desc || "Описание появится позже")}</p>
            <p class="route-meta">Координаты: ${formatCoord(point.lat)}, ${formatCoord(point.lon)}</p>
            ${eta ? `<p class="route-meta">В пути ≈ ${eta} мин</p>` : ""}
          </article>
        `;
      })
      .join("");
  }

  function syncPreferences(prefs) {
    if (!elements.prefsForm) {
      return;
    }
    const { tags = [], budget = "low", pace = "normal" } = prefs || {};
    elements.prefsForm.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.checked = tags.includes(checkbox.value);
    });
    elements.prefsForm.querySelectorAll('input[name="budget"]').forEach((input) => {
      input.checked = input.value === budget;
    });
    elements.prefsForm.querySelectorAll('input[name="pace"]').forEach((input) => {
      input.checked = input.value === pace;
    });
  }

  function attachEvents() {
    elements.buildButton?.addEventListener("click", () => {
      console.log("[UI] Нажата кнопка построения маршрута");
      handlers.onBuildRoute?.();
    });

    elements.downloadIcsButton?.addEventListener("click", () => {
      console.log("[UI] Нажата кнопка скачивания ICS");
      downloadIcs();
    });

    elements.explainButton?.addEventListener("click", () => {
      console.log("[UI] Нажата кнопка объяснения маршрута");
      handlers.onExplain?.();
    });

    elements.viewRouteButton?.addEventListener("click", () => {
      console.log("[UI] Нажата верхняя кнопка «Маршрут»");
      handlers.onViewRoute?.();
    });

    elements.preferencesButton?.addEventListener("click", () => {
      console.log("[UI] Открытие модалки предпочтений");
      syncPreferences(getState().prefs);
      elements.prefsModal?.showModal();
    });

    elements.chatButton?.addEventListener("click", () => {
      console.log("[UI] Запрошен чат-заглушка");
      elements.chatModal?.showModal();
      handlers.onChatOpen?.();
    });

    elements.prefsModal?.addEventListener("close", () => {
      if (elements.prefsModal.returnValue === "default") {
        const prefs = getPrefsFromForm();
        handlers.onPreferencesChange?.(prefs);
      }
    });
  }

  function init(customHandlers) {
    handlers = customHandlers || {};
    attachEvents();
  }

  function scrollRouteList() {
    elements.routeList?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  global.UI = {
    init,
    renderRouteList,
    showToast,
    syncPreferences,
    scrollRouteList,
    setStateGetter(fn) {
      if (typeof fn === "function") {
        getState = fn;
      }
    },
  };
})(window);
