// Misura della larghezza di un testo, per decidere se un'etichetta diretta STA
// dentro un segmento.
//
// La regola è "misura prima": un'etichetta che non entra non va tagliata, non va
// nascosta con overflow:hidden (che amputa il primo e l'ultimo carattere) e non va
// impilata fuori posto — semplicemente non si stampa, e il valore resta
// raggiungibile da legenda, tooltip e vista tabellare.

// `false` = canvas non disponibile, già tentato: distinto da `null` = mai tentato,
// così l'ambiente senza canvas non ripaga il try/catch a ogni misura.
let ctx: CanvasRenderingContext2D | false | null = null;

function context(): CanvasRenderingContext2D | false {
  if (ctx !== null) return ctx;
  try {
    const canvas = document.createElement("canvas");
    ctx = canvas.getContext("2d") ?? false;
  } catch {
    ctx = false;
  }
  return ctx;
}

/**
 * Larghezza in px del testo con il font indicato.
 *
 * Se il canvas non è disponibile (SSR, ambiente di test) si stima per eccesso:
 * sbagliare in eccesso significa stampare un'etichetta in meno, non tagliarne una.
 */
export function textWidth(text: unknown, font = "600 12px system-ui, sans-serif"): number {
  const s = String(text ?? "");
  const c = context();
  if (!c) return s.length * 7.4;
  c.font = font;
  return c.measureText(s).width;
}

/** true se `text` entra in `available` px lasciando `padding` px per lato. */
export function fitsIn(
  text: unknown,
  available: number,
  { font, padding = 8 }: { font?: string; padding?: number } = {}
): boolean {
  return textWidth(text, font) + padding * 2 <= available;
}
