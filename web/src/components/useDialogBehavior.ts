import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// Il comportamento comune a TUTTI i pannelli sovrapposti: drawer, modali, menu.
//
// Era scritto (a metà) in Drawer e in ConfirmDialog, con esiti diversi: il drawer
// chiudeva con Esc e il dialogo di conferma no, e nessuno dei due bloccava lo
// scroll della pagina dietro — su iOS il rubber-band fa scorrere l'elenco sotto
// il pannello mentre si compila un form.

/** Quante finestre sono aperte adesso, e cosa ripristinare quando si azzera. */
let openCount = 0;
let savedOverflow = "";
let savedPaddingRight = "";

// Un CONTATORE e non un booleano: in Movimenti il drawer e il dialogo di conferma
// eliminazione coesistono, e chiudendo il secondo un ripristino ingenuo
// sbloccherebbe lo scroll mentre il primo è ancora aperto.
function lockBodyScroll(): void {
  if (openCount === 0) {
    savedOverflow = document.body.style.overflow;
    savedPaddingRight = document.body.style.paddingRight;
    // Su desktop nascondere l'overflow fa sparire la scrollbar, e la pagina dietro
    // si allarga di 15px sotto il pannello: si rimpiazza la sua larghezza con del
    // padding. Su mobile la scrollbar non occupa spazio e il calcolo dà zero.
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    document.body.style.overflow = "hidden";
  }
  openCount += 1;
}

function unlockBodyScroll(): void {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0) {
    document.body.style.overflow = savedOverflow;
    document.body.style.paddingRight = savedPaddingRight;
  }
}

interface DialogBehaviorOptions {
  /** false mentre un'operazione è in corso: Esc non deve annullarla a metà. */
  closeOnEscape?: boolean;
  /**
   * Dove mandare il focus all'apertura, se non il pannello. Mai un campo di
   * testo: su telefono la tastiera si aprirebbe da sola e coprirebbe metà del
   * pannello prima che si legga il titolo.
   */
  initialFocus?: RefObject<HTMLElement | null>;
}

/**
 * Esc chiude, il focus entra nel pannello e torna dov'era, la pagina dietro sta
 * ferma.
 *
 * Il pannello deve avere `tabIndex={-1}`, altrimenti non è un bersaglio valido
 * per `focus()` e il focus resterebbe sull'elemento di prima.
 */
export default function useDialogBehavior(
  open: boolean,
  onClose: (() => void) | undefined,
  panelRef: RefObject<HTMLElement | null>,
  options: DialogBehaviorOptions = {}
): void {
  // `onClose` e `closeOnEscape` cambiano a ogni render (il secondo dipende da
  // `busy`): tenerli in un ref invece che nelle dipendenze evita che l'effetto si
  // rimonti, cosa che rifarebbe il focus e ricontrebbe l'apertura.
  const latest = useRef({ onClose, options });
  useEffect(() => {
    latest.current = { onClose, options };
  });

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    (latest.current.options.initialFocus?.current ?? panelRef.current)?.focus();
    lockBodyScroll();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (latest.current.options.closeOnEscape === false) return;
      latest.current.onClose?.();
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      unlockBodyScroll();
      // Il focus torna a chi l'aveva: senza, riparte da capo nel documento e da
      // tastiera si perde il punto in cui si era.
      previouslyFocused?.focus();
    };
  }, [open, panelRef]);
}
