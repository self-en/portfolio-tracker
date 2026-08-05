import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

interface ToastProviderProps {
  children?: ReactNode;
}

interface ToastProps {
  tone?: string;
  message?: any;
  onDismiss?: (...args: any[]) => void;
}


const ToastContext = createContext(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast richiede ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message, { tone = "info", durationMs = 5000 } = {}) => {
      seq.current += 1;
      const id = seq.current;
      setToasts((list) => [...list, { id, message, tone }]);
      if (durationMs > 0) window.setTimeout(() => dismiss(id), durationMs);
      return id;
    },
    [dismiss]
  );

  const api = useMemo(
    () => ({
      show,
      dismiss,
      success: (message, opts) => show(message, { ...opts, tone: "success" }),
      // Gli errori restano più a lungo: un messaggio che spiega cosa è andato
      // storto deve essere leggibile fino in fondo, non intravisto.
      error: (message, opts) => show(message, { durationMs: 9000, ...opts, tone: "error" }),
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <Toast key={t.id} tone={t.tone} message={t.message} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function Toast({ tone = "info", message, onDismiss }: ToastProps) {
  return (
    <div className={`toast toast--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="toast-message">{message}</span>
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="Chiudi">
        ×
      </button>
    </div>
  );
}
