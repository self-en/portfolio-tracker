import { extent, toNumber } from "./numbers";
import type { Convertible } from "./numbers";

export interface SparklineOptions {
  width?: number;
  height?: number;
  padding?: number;
  /** Oltre questo numero di punti la serie viene campionata. */
  maxPoints?: number;
}

/** Il path SVG e l'ultimo punto disegnato (dove va il pallino di testa). */
export interface SparklineGeometry {
  d: string;
  last: { x: number; y: number } | null;
  width: number;
  height: number;
}

/**
 * Geometria di una sparkline: da una lista di stringhe decimali a un path SVG.
 *
 * Sta in charts/ perché è QUI che i decimali diventano coordinate in pixel; il
 * componente components/Sparkline.tsx si limita a disegnare ciò che riceve.
 *
 * null quando i punti utilizzabili sono meno di due: una sparkline con un punto
 * solo non è una tendenza.
 */
export default function sparklinePath(
  values: Convertible[] | null | undefined,
  opts: SparklineOptions = {}
): SparklineGeometry | null {
  const { width = 132, height = 34, padding = 3, maxPoints = 60 } = opts;

  const nums = (values || []).map(toNumber);
  // Serie lunga: si campiona invece di disegnare 400 segmenti in 130px.
  const step = nums.length > maxPoints ? Math.ceil(nums.length / maxPoints) : 1;
  const sampled = step === 1 ? nums : nums.filter((_, i) => i % step === 0 || i === nums.length - 1);
  const usable = sampled.filter((v): v is number => v !== null);

  if (usable.length < 2) return null;

  const { min, max } = extent(usable);
  // `usable` non è vuoto, quindi extent ha trovato entrambi gli estremi: il
  // controllo serve a TypeScript, non al runtime.
  if (min === null || max === null) return null;

  const span = max - min;
  const innerH = height - padding * 2;
  const innerW = width - padding * 2;
  const dx = innerW / (sampled.length - 1);
  // Serie piatta: la linea va a metà altezza, non sul bordo.
  const y = (v: number) =>
    span === 0 ? padding + innerH / 2 : padding + innerH - ((v - min) / span) * innerH;

  let d = "";
  let last: SparklineGeometry["last"] = null;
  let open = false;
  sampled.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    const px = padding + dx * i;
    const py = y(v);
    d += `${open ? "L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`;
    open = true;
    last = { x: px, y: py };
  });

  return { d, last, width, height };
}
