type TabKey = "route" | "preferences" | "chat";

interface TabsProps {
  active: TabKey;
  onChange: (tab: TabKey) => void;
}

const TABS: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: "route", label: "Маршрут", icon: "🗺️" },
  { key: "preferences", label: "Предпочтения", icon: "🎚️" },
  { key: "chat", label: "Чат", icon: "💬" }
];

export function Tabs({ active, onChange }: TabsProps) {
  return (
    <nav className="tab-bar" aria-label="Основная навигация">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          className={`tab-btn${tab.key === active ? " tab-btn--active" : ""}`}
          onClick={() => onChange(tab.key)}
          aria-label={tab.label}
        >
          <span aria-hidden="true">{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
