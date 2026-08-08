import { useRef } from "react";
import useDialogBehavior from "./useDialogBehavior";
import type { ReactNode } from "react";

interface DrawerProps {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose?: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}


/**
 * Pannello laterale per i form.
 *
 * Un drawer e non una pagina: inserendo un movimento si vuole continuare a vedere
 * l'elenco dietro, che è il contesto di ciò che si sta scrivendo.
 */
export default function Drawer({ open, title, subtitle, onClose, children, footer }: DrawerProps) {
  const panelRef = useRef<HTMLElement>(null);

  // Esc chiude, il focus entra nel PANNELLO e la pagina dietro sta ferma. Non più
  // sul primo campo: su telefono aprirebbe la tastiera coprendo metà del drawer
  // prima che si legga il titolo. Da tastiera resta corretto — il focus è nel
  // dialogo e il primo Tab arriva sul primo campo.
  useDialogBehavior(open, onClose, panelRef);

  if (!open) return null;

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <section
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Senza tabIndex la <section> non è un bersaglio valido per focus().
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="drawer-header">
          <div>
            <h2 className="drawer-title">{title}</h2>
            {subtitle ? <p className="muted small drawer-subtitle">{subtitle}</p> : null}
          </div>
          <button type="button" className="btn btn--ghost btn--small" onClick={onClose}>
            Chiudi
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer ? <footer className="drawer-footer">{footer}</footer> : null}
      </section>
    </div>
  );
}
