import { useEffect, useRef } from "react";
import Spinner from "./Spinner.jsx";

/**
 * Conferma per le azioni distruttive.
 *
 * Il fuoco iniziale va sul bottone di ANNULLA, non su quello di conferma: un
 * Invio battuto per abitudine non deve cancellare un movimento.
 */
export default function ConfirmDialog({
  open,
  title = "Confermi?",
  message,
  detail,
  confirmLabel = "Conferma",
  cancelLabel = "Annulla",
  danger = false,
  busy = false,
  extraAction = null,
  onConfirm,
  onCancel,
}) {
  const cancelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    cancelRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === "Escape" && !busy) onCancel?.();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-root">
      <div className="drawer-backdrop" aria-hidden="true" />
      <div className="modal card" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2 className="modal-title">{title}</h2>
        {message ? <p className="modal-message">{message}</p> : null}
        {detail ? <p className="muted small">{detail}</p> : null}
        <div className="row modal-actions">
          <button
            type="button"
            className="btn"
            ref={cancelRef}
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          {extraAction}
          <button
            type="button"
            className={danger ? "btn btn--danger" : "btn btn--primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Spinner inline label="Operazione in corso…" /> : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
