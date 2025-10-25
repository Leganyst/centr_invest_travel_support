import { useCallback, useEffect, useMemo, useState } from "react";
import { MapView } from "./components/MapView";
import { BottomSheet, SheetState } from "./components/BottomSheet";
import { Tabs } from "./components/Tabs";
import { PreferencesModal, PreferencesData } from "./components/PreferencesModal";
import { ChatModal, ChatMessage, ChatOption } from "./components/ChatModal";
import { Toast } from "./components/Toast";
import type {
  AppConfig,
  PlanRequestPayload,
  PlanResponse,
  StartPoint,
  Stop,
  ChatResponse,
  ChatResponseAsk,
  ChatResponseReady
} from "./types";
import "./styles/app.css";

const DEFAULT_CITY_CENTER: StartPoint = {
  lat: 47.222078,
  lon: 39.720349,
  accuracy_m: null,
  source: "city"
};

interface PlanState {
  response: PlanResponse | null;
  stops: Stop[];
  lastPayload: PlanRequestPayload | null;
}

interface ChatState {
  messages: ChatMessage[];
  options: ChatOption[];
  allowMultiple: boolean;
  knownPrefs: Record<string, unknown>;
  readyPrefs: Record<string, unknown> | null;
  currentField: string | null;
  currentInput: "date" | "single" | "multiselect" | null;
}

function parseConfig(): AppConfig {
  const script = document.getElementById("app-config");
  if (!script) {
    throw new Error("App config script not found");
  }
  try {
    const payload = JSON.parse(script.textContent || "{}");
    return {
      mapglKey: payload.mapglKey || "",
      defaultCity: payload.defaultCity || "Ростов-на-Дону",
      allowedTags: Array.isArray(payload.allowedTags) ? payload.allowedTags : [],
      llmEnabled: Boolean(payload.llmEnabled)
    };
  } catch (error) {
    console.error("Failed to parse app config", error);
    return {
      mapglKey: "",
      defaultCity: "Ростов-на-Дону",
      allowedTags: [],
      llmEnabled: false
    };
  }
}

const INITIAL_PLAN: PlanState = {
  response: null,
  stops: [],
  lastPayload: null
};

const INITIAL_CHAT: ChatState = {
  messages: [],
  options: [],
  allowMultiple: false,
  knownPrefs: {},
  readyPrefs: null,
  currentField: null,
  currentInput: null
};

type ActiveTab = "route" | "preferences" | "chat";

function isoToday(): string {
  const now = new Date();
  now.setHours(now.getHours() + 3);
  return now.toISOString().slice(0, 10);
}

async function requestGeolocation(): Promise<StartPoint | null> {
  if (!navigator.geolocation) {
    return null;
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy_m: position.coords.accuracy,
          source: "user"
        });
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

let chatMessageId = 0;

export default function App() {
  const config = useMemo(parseConfig, []);

  const [sheetState, setSheetState] = useState<SheetState>("peek");
  const [planState, setPlanState] = useState<PlanState>(INITIAL_PLAN);
  const [startPoint, setStartPoint] = useState<StartPoint>({ ...DEFAULT_CITY_CENTER });
  const [selectedStop, setSelectedStop] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("route");
  const [toast, setToast] = useState<string | null>(null);
  const [isPreferencesOpen, setPreferencesOpen] = useState(false);
  const [isChatOpen, setChatOpen] = useState(false);
  const [chatState, setChatState] = useState<ChatState>(INITIAL_CHAT);
  const [isPlanning, setPlanning] = useState(false);
  const [explainText, setExplainText] = useState<string | null>(null);
  const [isExplainOpen, setExplainOpen] = useState(false);

  const allowedTags = useMemo(() => {
    if (!config.allowedTags.length) {
      return [
        "history",
        "museum",
        "art",
        "architecture",
        "park",
        "walk",
        "food",
        "coffee",
        "family",
        "nature"
      ];
    }
    return config.allowedTags;
  }, [config.allowedTags]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleToggleSheet = useCallback(() => {
    setSheetState((prev) => {
      switch (prev) {
        case "peek":
          return "half";
        case "half":
          return "full";
        default:
          return "peek";
      }
    });
  }, []);

  const handleSelectStop = useCallback((index: number) => {
    setSelectedStop(index);
    setSheetState("half");
  }, []);

  const updatePlan = useCallback((payload: PlanRequestPayload, response: PlanResponse) => {
    setPlanState({
      response,
      stops: response.stops || [],
      lastPayload: payload
    });
    setSelectedStop(response.stops.length ? 0 : null);
  }, []);

  const handlePlan = useCallback(
    async (payload: PlanRequestPayload, options?: { showToast?: boolean }) => {
      try {
        setPlanning(true);
        if (options?.showToast !== false) {
          setToast("Строим маршрут…");
        }
        const response = await fetch("/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const data: PlanResponse = await response.json();
        updatePlan(payload, data);
        if (!payload.user_location) {
          setStartPoint({ ...DEFAULT_CITY_CENTER });
        }
        setToast("Маршрут готов!");
      } catch (error) {
        console.error("/plan request failed", error);
        setToast(
          error instanceof Error
            ? `Не удалось построить маршрут: ${error.message}`
            : "Не удалось построить маршрут"
        );
      } finally {
        setPlanning(false);
      }
    },
    [updatePlan]
  );

  const handlePreferencesSubmit = useCallback(
    async (data: PreferencesData) => {
      setPreferencesOpen(false);
      setActiveTab("route");

      let nextStartPoint: StartPoint = DEFAULT_CITY_CENTER;
      if (data.useGeolocation) {
        const geoPoint = await requestGeolocation();
        if (geoPoint) {
          nextStartPoint = geoPoint;
          setStartPoint({ ...geoPoint });
        } else {
          setToast("Не удалось определить геопозицию. Используем центр города.");
          setStartPoint({ ...DEFAULT_CITY_CENTER });
        }
      } else {
        setStartPoint({ ...DEFAULT_CITY_CENTER });
      }

      const payload: PlanRequestPayload = {
        city: config.defaultCity,
        date: data.date,
        tags: data.tags.length ? data.tags : undefined,
        budget: data.budget || undefined,
        pace: data.pace || undefined,
        user_location:
          data.useGeolocation && nextStartPoint.source === "user"
            ? {
                lat: nextStartPoint.lat,
                lon: nextStartPoint.lon,
                accuracy_m: nextStartPoint.accuracy_m ?? undefined
              }
            : undefined
      };

      await handlePlan(payload);
    },
    [config.defaultCity, handlePlan]
  );

  const handleTabsChange = useCallback(
    (tab: ActiveTab) => {
      setActiveTab(tab);
      if (tab === "preferences") {
        setPreferencesOpen(true);
      } else if (tab === "chat") {
        setChatOpen(true);
        if (chatState.messages.length === 0) {
          void requestNextChatStep(chatState.knownPrefs);
        }
      } else {
        setPreferencesOpen(false);
        setChatOpen(false);
      }
    },
    [chatState.knownPrefs, chatState.messages.length]
  );

  const handleDownloadIcs = useCallback(() => {
    if (!planState.response?.ics) {
      setToast("Сначала постройте маршрут");
      return;
    }
    const filename = planState.lastPayload?.date
      ? `route_${planState.lastPayload.date}.ics`
      : "route.ics";
    const blob = new Blob([planState.response.ics], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [planState]);

  const handleExplain = useCallback(async () => {
    if (!planState.lastPayload || !planState.response?.stops.length) {
      setToast("Постройте маршрут, чтобы получить объяснение");
      return;
    }
    try {
      setExplainOpen(true);
      setExplainText("Получаем объяснение маршрута…");
      const response = await fetch("/llm/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prefs: planState.lastPayload,
          stops: planState.response.stops
        })
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const data = await response.json();
      setExplainText(data.text || "Маршрут построен исходя из интересов и близости точек.");
    } catch (error) {
      console.error("/llm/explain failed", error);
      setExplainText(
        error instanceof Error
          ? `Не удалось получить объяснение: ${error.message}`
          : "Не удалось получить объяснение маршрута"
      );
    }
  }, [planState]);

  const appendChatMessage = useCallback((sender: "assistant" | "user", text: string) => {
    chatMessageId += 1;
    setChatState((prev) => ({
      ...prev,
      messages: [...prev.messages, { id: String(chatMessageId), sender, text }]
    }));
  }, []);

  const setChatOptions = useCallback((options: string[], allowMultiple: boolean) => {
    setChatState((prev) => ({
      ...prev,
      options: options.map((value) => ({ value, selected: false })),
      allowMultiple
    }));
  }, []);

  const requestNextChatStep = useCallback(
    async (knownPrefs: Record<string, unknown>) => {
      try {
        const response = await fetch("/llm/next", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ known_prefs: knownPrefs })
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const data: ChatResponse = await response.json();
        if ((data as ChatResponseAsk).mode === "ask") {
          const ask = data as ChatResponseAsk;
          appendChatMessage("assistant", ask.note ? `${ask.question}\n(${ask.note})` : ask.question);
          setChatState((prev) => ({
            ...prev,
            knownPrefs: ask.known_prefs || prev.knownPrefs,
            readyPrefs: null,
            currentField: ask.field,
            currentInput: ask.input
          }));
          setChatOptions(ask.options || [], ask.input === "multiselect");
        } else if ((data as ChatResponseReady).mode === "ready") {
          const ready = data as ChatResponseReady;
          appendChatMessage(
            "assistant",
            ready.note || "Можем строить маршрут — нажмите «Собрать маршрут»."
          );
          setChatOptions([], false);
          setChatState((prev) => ({
            ...prev,
            readyPrefs: ready.prefs,
            knownPrefs: { ...prev.knownPrefs, ...ready.prefs },
            currentField: null,
            currentInput: null
          }));
        } else {
          appendChatMessage("assistant", "Не удалось обработать ответ ассистента.");
        }
      } catch (error) {
        console.error("/llm/next failed", error);
        appendChatMessage(
          "assistant",
          error instanceof Error
            ? `Ассистент недоступен: ${error.message}`
            : "Ассистент недоступен, заполните форму вручную."
        );
      }
    },
    [appendChatMessage, setChatOptions]
  );

  const handleChatOptionToggle = useCallback((value: string) => {
    let selectedForSend: string | null = null;
    setChatState((prev) => {
      const nextOptions = prev.options.map((option) =>
        option.value === value
          ? { ...option, selected: prev.allowMultiple ? !option.selected : true }
          : prev.allowMultiple
          ? option
          : { ...option, selected: false }
      );

      if (!prev.allowMultiple) {
        const selected = nextOptions.find((option) => option.selected);
        if (selected) {
          const field = prev.currentField || "choice";
          const updatedPrefs = { ...prev.knownPrefs };
          updatedPrefs[field] = selected.value;
          selectedForSend = selected.value;
          void requestNextChatStep(updatedPrefs);
          return {
            ...prev,
            options: [],
            knownPrefs: updatedPrefs,
            currentField: null,
            currentInput: null
          };
        }
      }

      return {
        ...prev,
        options: nextOptions
      };
    });
    if (selectedForSend) {
      appendChatMessage("user", selectedForSend);
    }
  }, [appendChatMessage, requestNextChatStep]);

  const submitChatOptions = useCallback(() => {
    let selectedValues: string[] | null = null;
    let updatedPrefs: Record<string, unknown> | null = null;
    setChatState((prev) => {
      const selected = prev.options.filter((option) => option.selected).map((option) => option.value);
      if (!selected.length) {
        return prev;
      }
      const field = prev.currentField || "tags";
      selectedValues = selected;
      updatedPrefs = { ...prev.knownPrefs } as Record<string, unknown>;
      updatedPrefs[field] = prev.allowMultiple ? selected : selected[0];
      void requestNextChatStep(updatedPrefs);
      return {
        ...prev,
        options: [],
        knownPrefs: updatedPrefs,
        currentField: null,
        currentInput: null
      };
    });
    if (selectedValues) {
      appendChatMessage("user", selectedValues.join(", "));
    }
  }, [appendChatMessage, requestNextChatStep]);

  const handleChatSend = useCallback(
    (message: string) => {
      appendChatMessage("user", message);
      setChatState((prev) => {
        const updatedPrefs = { ...prev.knownPrefs };
        if (prev.currentField) {
          updatedPrefs[prev.currentField] = message;
        }
        void requestNextChatStep(updatedPrefs);
        return {
          ...prev,
          knownPrefs: updatedPrefs,
          options: [],
          currentField: null,
          currentInput: null
        };
      });
    },
    [appendChatMessage, requestNextChatStep]
  );

  const handleChatPlan = useCallback(async () => {
    if (!chatState.readyPrefs) {
      setToast("Сначала ответьте на вопросы ассистента");
      return;
    }
    const date = String(chatState.readyPrefs.date || isoToday());
    const payload: PlanRequestPayload = {
      city: String(chatState.readyPrefs.city || config.defaultCity || "Ростов-на-Дону"),
      date,
      tags: Array.isArray(chatState.readyPrefs.tags)
        ? (chatState.readyPrefs.tags as string[])
        : undefined,
      budget: typeof chatState.readyPrefs.budget === "string" ? chatState.readyPrefs.budget : undefined,
      pace: typeof chatState.readyPrefs.pace === "string" ? chatState.readyPrefs.pace : undefined
    };
    setChatOpen(false);
    setActiveTab("route");
    await handlePlan(payload, { showToast: true });
  }, [chatState.readyPrefs, config.defaultCity, handlePlan]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-brand">
          <span className="logo" aria-hidden="true">
            🧭
          </span>
          <div>
            <h1>Маршрут на день</h1>
            <p className="current-date">{planState.lastPayload?.date ?? isoToday()}</p>
          </div>
        </div>
        <button
          className="icon-button"
          aria-label="Настройки предпочтений"
          onClick={() => {
            setPreferencesOpen(true);
            setActiveTab("preferences");
          }}
        >
          ⚙️
        </button>
      </header>

      <main className="app-main">
        <MapView
          mapKey={config.mapglKey}
          stops={planState.stops}
          startPoint={startPoint}
          selectedIndex={selectedStop}
          onMarkerSelect={handleSelectStop}
          onMapError={setToast}
        />
        <BottomSheet
          sheetState={sheetState}
          onToggle={handleToggleSheet}
          stops={planState.stops}
          selectedIndex={selectedStop}
          onSelectStop={handleSelectStop}
          onBuild={() => {
            setPreferencesOpen(true);
            setActiveTab("preferences");
          }}
          onDownload={handleDownloadIcs}
          onExplain={handleExplain}
          canDownload={Boolean(planState.response?.ics)}
          canExplain={Boolean(planState.response?.stops.length)}
          totalTime={planState.response?.total_time ?? null}
          dataSource={planState.response?.data_source ?? null}
          optimized={Boolean(planState.response?.optimized)}
          startPoint={startPoint}
        />
      </main>

      <Tabs active={activeTab} onChange={handleTabsChange} />

      <PreferencesModal
        open={isPreferencesOpen}
        onClose={() => {
          setPreferencesOpen(false);
          setActiveTab("route");
        }}
        onSubmit={handlePreferencesSubmit}
        allowedTags={allowedTags}
        initialDate={planState.lastPayload?.date ?? isoToday()}
        selectedTags={planState.lastPayload?.tags ?? []}
        selectedBudget={planState.lastPayload?.budget ?? null}
        selectedPace={planState.lastPayload?.pace ?? null}
        geolocationEnabled={startPoint.source === "user"}
      />

      <ChatModal
        open={isChatOpen}
        onClose={() => {
          setChatOpen(false);
          setActiveTab("route");
        }}
        messages={chatState.messages}
        options={chatState.options}
        allowMultiple={chatState.allowMultiple}
        readyToPlan={Boolean(chatState.readyPrefs)}
        onToggleOption={handleChatOptionToggle}
        onSubmitOptions={submitChatOptions}
        onSendMessage={handleChatSend}
        onPlan={handleChatPlan}
      />

      {isExplainOpen && (
        <dialog className="modal" open onClose={() => setExplainOpen(false)}>
          <div className="modal-content">
            <header>Объяснение маршрута</header>
            <div className="explain-text">{explainText}</div>
            <menu className="modal-menu">
              <button type="button" className="primary-btn" onClick={() => setExplainOpen(false)}>
                Понятно
              </button>
            </menu>
          </div>
        </dialog>
      )}

      <Toast message={toast} />
    </div>
  );
}
