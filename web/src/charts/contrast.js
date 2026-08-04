// Contrasto: serve a UNA cosa sola, scegliere il colore di un'etichetta stampata
// DENTRO una campitura colorata (un segmento della barra di allocazione).
//
// È l'unica eccezione alla regola "il testo indossa token di TESTO": un'etichetta
// dentro un segmento colorato prende inchiostro o superficie secondo la luminanza
// del riempimento, così supera il contrasto qualunque sia la tinta.
//
// Non si scrive nessun hex qui: i candidati arrivano dal tema (`textPrimary` e
// `surface`), e si sceglie quello che stacca di più.

import { clamp } from "./numbers.js";

/** Colore esadecimale a 6 cifre → [r, g, b]. Ritorna null se non lo è. */
function channels(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const int = Number.parseInt(m[1], 16);
  // eslint-disable-next-line no-bitwise -- estrazione di canali: il float qui è un pixel, non denaro
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

const linear = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

/** Luminanza relativa WCAG. */
export function relativeLuminance(hex) {
  const rgb = channels(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Rapporto di contrasto WCAG tra due colori. null se uno dei due non è un hex. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Colore di testo da stampare sopra `fill`: inchiostro o superficie, quello che
 * contrasta di più. Entrambi i candidati vengono dal tema.
 */
export function textOnFill(fill, theme) {
  const ink = contrastRatio(fill, theme.textPrimary) ?? 0;
  const paper = contrastRatio(fill, theme.surface) ?? 0;
  return ink >= paper ? theme.textPrimary : theme.surface;
}

/** Opacità del wash di un'area: la tinta della serie a ~10%, mai un blocco saturo. */
export const AREA_FILL_OPACITY = clamp(0.14, 0, 1);
