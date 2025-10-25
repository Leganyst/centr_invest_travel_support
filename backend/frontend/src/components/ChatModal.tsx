import { FormEvent, useEffect, useRef } from "react";

export interface ChatMessage {
  id: string;
  sender: "assistant" | "user";
  text: string;
}

export interface ChatOption {
  value: string;
  selected: boolean;
}

interface ChatModalProps {
  open: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  options: ChatOption[];
  allowMultiple: boolean;
  readyToPlan: boolean;
  onToggleOption: (value: string) => void;
  onSubmitOptions: () => void;
  onSendMessage: (message: string) => void;
  onPlan: () => void;
}

export function ChatModal({
  open,
  onClose,
  messages,
  options,
  allowMultiple,
  readyToPlan,
  onToggleOption,
  onSubmitOptions,
  onSendMessage,
  onPlan
}: ChatModalProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      queueMicrotask(() => inputRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = inputRef.current?.value.trim();
    if (!value) {
      return;
    }
    onSendMessage(value);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  return (
    <dialog ref={dialogRef} className="modal chat-modal" onClose={onClose}>
      <div className="modal-content chat-content">
        <header>Ассистент маршрута</header>
        <div className="chat-log" aria-live="polite">
          {messages.length === 0 && (
            <div className="chat-bubble assistant">Привет! Помогу собрать маршрут.</div>
          )}
          {messages.map((message) => (
            <div
              key={message.id}
              className={`chat-bubble chat-bubble--${message.sender}`}
            >
              {message.text}
            </div>
          ))}
        </div>
        {options.length > 0 && (
          <div className="chat-options">
            {options.map((option) => (
              <button
                type="button"
                key={option.value}
                data-selected={option.selected}
                onClick={() => onToggleOption(option.value)}
              >
                {option.value}
              </button>
            ))}
            {allowMultiple && (
              <button type="button" className="confirm-btn" onClick={onSubmitOptions}>
                Готово
              </button>
            )}
          </div>
        )}
        <form ref={formRef} className="chat-form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            name="message"
            placeholder="Напишите ответ…"
            autoComplete="off"
          />
          <button type="submit">Отправить</button>
        </form>
        <menu className="modal-menu">
          <button type="button" className="primary-btn" disabled={!readyToPlan} onClick={onPlan}>
            Собрать маршрут
          </button>
          <button type="button" className="secondary-btn" onClick={onClose}>
            Закрыть
          </button>
        </menu>
      </div>
    </dialog>
  );
}
