import { useRef } from "react";
import Spinner from "./Spinner";
import useDialogBehavior from "./useDialogBehavior";
import type { ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message?: ReactNode;
  detail?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  danger?: boolean;
  busy?: boolean;
  extraAction?: ReactNode;
  onConfirm?: () => void;
  onCancel?: () => void;
}


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
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Il focus iniziale resta su ANNULLA (non è un campo, quindi non apre nessuna
  // tastiera) e Esc non chiude mentre l'operazione è in corso: interromperla a
  // metà lascerebbe l'utente senza sapere se è andata a buon fine.
  useDialogBehavior(open, onCancel, panelRef, {
    closeOnEscape: !busy,
    initialFocus: cancelRef,
  });

  if (!open) return null;

  return (
    <div className="modal-root">
      <div className="drawer-backdrop" aria-hidden="true" />
      <div
        className="modal card"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
      >
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
