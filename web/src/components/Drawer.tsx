import { useEffect, useRef } from "react";
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

  // Esc chiude, e il focus entra nel pannello: senza, la tastiera resterebbe sulla
  // tabella dietro, con l'utente che digita in un campo che non vede.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKeyDown);
    const first = panelRef.current?.querySelector<HTMLElement>(
      "input:not([readonly]), select, textarea, button"
    );
    first?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <section
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
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
