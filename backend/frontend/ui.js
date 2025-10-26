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
    originLabel: document.getElementById("origin-label"),
    pickOriginButton: document.getElementById("btn-origin-pick"),
    geolocateOriginButton: document.getElementById("btn-origin-geolocate"),
    clearOriginButton: document.getElementById("btn-origin-clear"),
  };

  let toastTimer = null;
  let getState = () => ({
    points: [],
    route: null,
    routePlan: null,
    prefs: { city: "Ростов-на-Дону", tags: [], budget: "low", pace: "normal" },
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

  function diffMinutes(start, end) {
    if (!start || !end) {
      return null;
    }
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return null;
    }
    return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 60000));
  }

  function escapeIcs(value) {
    return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  }

  function formatDateUtc(date) {
    return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  }

  function generateIcs(state) {
    const stops = state.routePlan?.stops;
    const points = stops && stops.length
      ? stops.map((stop, index) => ({
          title: stop.name || `Точка ${index + 1}`,
          desc: Array.isArray(stop.tags) && stop.tags.length ? stop.tags.join(", ") : "",
          arrive: stop.arrive,
          leave: stop.leave,
        }))
      : state.points;

    if (!points.length) {
      return "";
    }
    const now = new Date();

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//CentrInvest Travel Support//Route Planner//RU",
      "CALSCALE:GREGORIAN",
    ];

    points.forEach((point, index) => {
      const baseStart = new Date(now);
      baseStart.setHours(10, 0, 0, 0);
      const eventStart = point.arrive ? new Date(point.arrive) : new Date(baseStart.getTime() + index * 60 * 60 * 1000);
      const eventEnd = point.leave ? new Date(point.leave) : new Date(eventStart.getTime() + 60 * 60 * 1000);
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
    const ics = generateIcs(state);
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

  function renderRouteList(points, route, plan, extras = {}) {
    const container = elements.routeList;
    if (!container) {
      return;
    }
    if (!points.length) {
      container.innerHTML = `<p class="route-meta">Пока маршрут не построен. Нажмите «Построить».</p>`;
      return;
    }
    const legs = route?.legs ?? [];
    const explanation =
      extras && typeof extras.explanation === "string" ? extras.explanation.trim() : "";
    const summaryParts = [];
    if (plan?.total_time) {
      summaryParts.push(`≈ ${escapeHtml(plan.total_time)}`);
    } else if (plan?.total_minutes) {
      summaryParts.push(`≈ ${plan.total_minutes} мин`);
    }
    if (plan?.stops?.length) {
      summaryParts.push(`${plan.stops.length} точек`);
    }

    const summaryHtml = summaryParts.length
      ? `<header class="route-summary"><span class="summary-label">Маршрут</span><span class="summary-value">${summaryParts.join(" · ")}</span></header>`
      : "";

    const explanationHtml = explanation
      ? `<section class="route-explanation">
          <h4>Почему именно эти места</h4>
          <p>${escapeHtml(explanation).replace(/\n/g, "<br>")}</p>
        </section>`
      : "";

    container.innerHTML =
      summaryHtml +
      explanationHtml +
      points
      .map((point, index) => {
        const leg = legs[index - 1];
        const eta = leg?.duration ? Math.round(leg.duration / 60) : 0;
        const stopPlan = plan?.stops?.[index];
        const arriveTime = formatTime(stopPlan?.arrive);
        const leaveTime = formatTime(stopPlan?.leave);
        const stayMinutes = diffMinutes(stopPlan?.arrive, stopPlan?.leave);
        const tags = Array.isArray(stopPlan?.tags) && stopPlan.tags.length ? stopPlan.tags.join(", ") : null;
        const description = typeof point.description === "string" && point.description.trim()
          ? point.description.trim()
          : (typeof point.desc === "string" ? point.desc : "");
        return `
          <article class="route-item">
            <h3><span class="route-step">${index + 1}</span>${escapeHtml(point.title || `Точка ${index + 1}`)}</h3>
            ${description ? `<p class="route-desc">${escapeHtml(description)}</p>` : ""}
            <p class="route-meta">Координаты: ${formatCoord(point.lat)}, ${formatCoord(point.lon)}</p>
            ${eta ? `<p class="route-meta">Переход от предыдущей точки ≈ ${eta} мин</p>` : ""}
            ${arriveTime || leaveTime ? `<p class="route-meta">${arriveTime ? `Прибытие ${arriveTime}` : ""}${arriveTime && leaveTime ? " · " : ""}${leaveTime ? `Отправление ${leaveTime}` : ""}</p>` : ""}
            ${stayMinutes ? `<p class="route-meta">На месте ≈ ${stayMinutes} мин</p>` : ""}
            ${tags ? `<p class="route-tags">${escapeHtml(tags)}</p>` : ""}
          </article>
        `;
      })
      .join("");
  }

  function describeOrigin(origin) {
    if (!origin) {
      return "Старт: центр города (по умолчанию)";
    }
    const lat = Number(origin.lat);
    const lon = Number(origin.lon);
    const coordText =
      Number.isFinite(lat) && Number.isFinite(lon)
        ? `${lat.toFixed(5)}, ${lon.toFixed(5)}`
        : "координаты недоступны";
    const meta = [];
    meta.push(`Старт: ${coordText}`);
    if (origin.source === "geolocation") {
      meta.push("моя геолокация");
    } else if (origin.source === "map") {
      meta.push("точка на карте");
    } else if (origin.source) {
      meta.push(String(origin.source));
    }
    if (Number.isFinite(origin.accuracy) && origin.accuracy > 0) {
      meta.push(`±${Math.round(origin.accuracy)} м`);
    }
    return meta.join(" · ");
  }

  function updateOriginIndicator(origin) {
    if (!elements.originLabel) return;
    elements.originLabel.textContent = describeOrigin(origin);
    if (elements.clearOriginButton) {
      elements.clearOriginButton.disabled = !origin;
    }
  }

  function populateTags(tags) {
    const form = elements.prefsForm;
    if (!form || !Array.isArray(tags)) return;

    // контейнер под чекбоксы — создадим, если его нет
    let box = form.querySelector('[data-role="tags-box"]');
    if (!box) {
      box = document.createElement("div");
      box.setAttribute("data-role", "tags-box");
      box.className = "tags-box";
      // Вставь в удобное место формы; можно до первых полей:
      form.prepend(box);
    }

    box.innerHTML = tags
      .map(
        (tag) => `
        <label class="tag-option">
          <input type="checkbox" value="${tag}">
          <span>${escapeHtml(tag)}</span>
        </label>`
      )
      .join("");

    // после генерации — синхронизировать состояние (отметить уже выбранные)
    syncPreferences(getState().prefs);
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

    elements.pickOriginButton?.addEventListener("click", () => {
      console.log("[UI] Запрошена установка старта на карте");
      handlers.onPickOrigin?.();
    });

    elements.geolocateOriginButton?.addEventListener("click", () => {
      console.log("[UI] Запрошена установка старта по геолокации");
      handlers.onUseGeolocation?.();
    });

    elements.clearOriginButton?.addEventListener("click", () => {
      console.log("[UI] Запрошен сброс старта");
      handlers.onClearOrigin?.();
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
    populateTags,
    updateOriginIndicator,
    setStateGetter(fn) {
      if (typeof fn === "function") {
        getState = fn;
      }
    },
  };
})(window);
