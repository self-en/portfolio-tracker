import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

/** `error` sopravvive più a lungo e si annuncia come alert, non come status. */
export type ToastTone = "info" | "success" | "error";

export interface ToastOptions {
  tone?: ToastTone;
  /** 0 o meno: il toast resta finché non lo si chiude. */
  durationMs?: number;
}

interface ToastEntry {
  id: number;
  message: ReactNode;
  tone: ToastTone;
}

interface ToastApi {
  show: (message: ReactNode, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
  success: (message: ReactNode, opts?: ToastOptions) => number;
  error: (message: ReactNode, opts?: ToastOptions) => number;
}

interface ToastProviderProps {
  children?: ReactNode;
}

interface ToastProps {
  tone?: ToastTone;
  message?: ReactNode;
  onDismiss?: () => void;
}


const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast richiede ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: ReactNode, { tone = "info", durationMs = 5000 }: ToastOptions = {}) => {
      seq.current += 1;
      const id = seq.current;
      setToasts((list) => [...list, { id, message, tone }]);
      if (durationMs > 0) window.setTimeout(() => dismiss(id), durationMs);
      return id;
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
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
