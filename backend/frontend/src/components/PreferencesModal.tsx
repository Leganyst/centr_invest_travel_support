import { FormEvent, useEffect, useMemo, useRef } from "react";

export interface PreferencesData {
  date: string;
  tags: string[];
  budget?: string | null;
  pace?: string | null;
  useGeolocation: boolean;
}

interface PreferencesModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: PreferencesData) => void;
  allowedTags: string[];
  initialDate: string;
  selectedTags: string[];
  selectedBudget?: string | null;
  selectedPace?: string | null;
  geolocationEnabled: boolean;
}

const BUDGET_OPTIONS = [
  { value: "", label: "Не важно" },
  { value: "low", label: "Низкий" },
  { value: "medium", label: "Средний" },
  { value: "high", label: "Высокий" }
];

const PACE_OPTIONS = [
  { value: "", label: "Обычный" },
  { value: "relaxed", label: "Спокойный" },
  { value: "normal", label: "Средний" },
  { value: "fast", label: "Быстрый" }
];

export function PreferencesModal({
  open,
  onClose,
  onSubmit,
  allowedTags,
  initialDate,
  selectedTags,
  selectedBudget,
  selectedPace,
  geolocationEnabled
}: PreferencesModalProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open && formRef.current) {
      formRef.current.reset();
    }
  }, [open]);

  const tagOptions = useMemo(
    () => allowedTags.map((tag) => ({ value: tag, label: tag })),
    [allowedTags]
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const date = String(formData.get("date") || "");
    if (!date) {
      return;
    }
    const tags = formData.getAll("tags") as string[];
    const budget = String(formData.get("budget") || "");
    const pace = String(formData.get("pace") || "");
    const useGeolocation = Boolean(formData.get("useGeolocation"));

    onSubmit({
      date,
      tags,
      budget: budget || null,
      pace: pace || null,
      useGeolocation
    });
  }

  return (
    <dialog ref={dialogRef} className="modal" onClose={onClose}>
      <form
        ref={formRef}
        method="dialog"
        className="modal-content"
        onSubmit={handleSubmit}
        aria-label="Настройки маршрута"
      >
        <header>Настроить маршрут</header>
        <label>
          Дата поездки
          <input name="date" type="date" required defaultValue={initialDate} />
        </label>
        <fieldset>
          <legend>Интересы</legend>
          <div className="chip-list">
            {tagOptions.map((tag) => (
              <label key={tag.value} className="chip">
                <input
                  type="checkbox"
                  name="tags"
                  value={tag.value}
                  defaultChecked={selectedTags.includes(tag.value)}
                />
                <span>{tag.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          Бюджет
          <select name="budget" defaultValue={selectedBudget ?? ""}>
            {BUDGET_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Темп прогулки
          <select name="pace" defaultValue={selectedPace ?? ""}>
            {PACE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            name="useGeolocation"
            defaultChecked={geolocationEnabled}
          />
          <span>Определить мою геопозицию</span>
        </label>
        <menu className="modal-menu">
          <button type="button" className="secondary-btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="primary-btn">
            Построить маршрут
          </button>
        </menu>
      </form>
    </dialog>
  );
}
