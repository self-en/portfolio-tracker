import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router-dom";
import useDialogBehavior from "./useDialogBehavior";

/** Una voce di navigazione. L'elenco resta in App.tsx, che è la sua sola fonte. */
export interface NavItem {
  to: string;
  label: string;
}

interface NavMenuProps {
  items: NavItem[];
  onLogout?: () => void;
}

// MENU A PANINO, sotto i 640px.
//
// La striscia orizzontale di link non stava in 360px: scorreva di lato con la
// scrollbar nascosta di proposito e nessuna affordance, quindi le ultime due voci
// erano di fatto invisibili. E la seconda riga sticky che si prendeva costava
// l'altezza che serve al contenuto.
//
// I due select globali (portafoglio, periodo) NON entrano qui: cambiano il
// significato di tutta la pagina, non sono azioni da seppellire in un menu.

/**
 * Le voci come NavLink, identiche in topbar e nel pannello: il comportamento
 * "attivo" è scritto una volta sola.
 */
export function NavLinks({ items }: { items: NavItem[] }) {
  return (
    <>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          // `end` solo sulla root: senza, "/" risulterebbe attivo su ogni rotta.
          end={item.to === "/"}
          className={({ isActive }) => (isActive ? "nav-link nav-link--active" : "nav-link")}
        >
          {item.label}
        </NavLink>
      ))}
    </>
  );
}

export default function NavMenu({ items, onLogout }: NavMenuProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();

  useDialogBehavior(open, () => setOpen(false), panelRef);

  // La chiusura è agganciata al CAMBIO DI ROTTA e non a un onClick per link: così
  // chiude anche una navigazione programmatica (un redirect, un link dentro la
  // pagina) e non serve ricordarselo su ogni voce.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const panel = (
    <div className="navmenu-root">
      <div className="drawer-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
      <div
        id="navmenu-panel"
        className="navmenu-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        tabIndex={-1}
        ref={panelRef}
      >
        <nav className="navmenu-list">
          <NavLinks items={items} />
        </nav>
        <div className="navmenu-foot">
          <button type="button" className="btn btn--ghost" onClick={onLogout}>
            Esci
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <button
        type="button"
        className="navmenu-toggle"
        aria-label="Apri il menu"
        aria-expanded={open}
        aria-controls="navmenu-panel"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">☰</span>
      </button>
      {/* Il pannello esce dalla topbar e va sul body: `.topbar` è sticky con uno
          z-index, quindi crea un contesto di impilamento e tutto ciò che sta
          dentro resta sotto ai toast e ai drawer, che hanno z-index maggiori. */}
      {open ? createPortal(panel, document.body) : null}
    </>
  );
}
