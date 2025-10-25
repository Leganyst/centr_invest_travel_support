import { Stop, StartPoint } from "../types";

export type SheetState = "peek" | "half" | "full";

interface BottomSheetProps {
  sheetState: SheetState;
  onToggle: () => void;
  stops: Stop[];
  selectedIndex: number | null;
  onSelectStop: (index: number) => void;
  onBuild: () => void;
  onDownload: () => void;
  onExplain: () => void;
  canDownload: boolean;
  canExplain: boolean;
  totalTime: string | null;
  dataSource: string | null;
  optimized: boolean;
  startPoint: StartPoint;
}

const SHEET_CLASS: Record<SheetState, string> = {
  peek: "bottom-sheet--peek",
  half: "bottom-sheet--half",
  full: "bottom-sheet--full"
};

export function BottomSheet({
  sheetState,
  onToggle,
  stops,
  selectedIndex,
  onSelectStop,
  onBuild,
  onDownload,
  onExplain,
  canDownload,
  canExplain,
  totalTime,
  dataSource,
  optimized,
  startPoint
}: BottomSheetProps) {
  const sheetClass = `bottom-sheet ${SHEET_CLASS[sheetState]}`;
  const startLabel =
    startPoint.source === "user"
      ? `Старт: моё местоположение${
          typeof startPoint.accuracy_m === "number"
            ? ` (±${Math.round(startPoint.accuracy_m)} м)`
            : ""
        }`
      : "Старт: центр города";

  return (
    <section className={sheetClass} aria-live="polite">
      <button className="sheet-handle" onClick={onToggle} aria-label="Развернуть список остановок" />
      <div className="sheet-header">
        <h2>Список остановок</h2>
        <div className="sheet-badges">
          {dataSource && (
            <span className="status-badge">
              Источник: {dataSource === "2gis" ? "2ГИС" : dataSource === "seed" ? "сиды" : dataSource}
            </span>
          )}
          {optimized && <span className="status-badge status-badge--success">Оптимизировано</span>}
        </div>
      </div>
      <p className="start-location-info">{startLabel}</p>
      <div className="sheet-actions">
        <button className="primary-btn" onClick={onBuild}>
          Построить
        </button>
        <button className="secondary-btn" onClick={onDownload} disabled={!canDownload}>
          Скачать .ics
        </button>
        <button className="secondary-btn" onClick={onExplain} disabled={!canExplain}>
          Объяснить
        </button>
      </div>
      {totalTime && <p className="total-time">Маршрут на день (~{totalTime})</p>}
      <div className="stops-list">
        {stops.length === 0 ? (
          <p className="empty-placeholder">
            Сначала задайте предпочтения, затем нажмите «Построить», чтобы увидеть маршрут.
          </p>
        ) : (
          stops.map((stop, index) => {
            const arrive = stop.arrive.slice(11, 16);
            const leave = stop.leave.slice(11, 16);
            const description =
              stop.description?.trim() ||
              (stop.tags.length ? `Теги: ${stop.tags.join(", ")}` : "Описание отсутствует");
            const active = selectedIndex === index;
            return (
              <article
                key={`${stop.lat}-${stop.lon}-${index}`}
                className={`stop-card${active ? " stop-card--active" : ""}`}
                onClick={() => onSelectStop(index)}
              >
                <span className="stop-number">{index + 1}</span>
                <div className="stop-info">
                  <h3>{stop.name}</h3>
                  <div className="stop-time">
                    {arrive} — {leave}
                  </div>
                </div>
                <div className="stop-desc">{description}</div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
