import { clamp } from "./numbers";

// Forma di una colonna, secondo le specifiche delle marche: estremità dei dati
// arrotondata di 4px, BASE QUADRA, e un gap di 2px in colore superficie tra i
// segmenti che si toccano.
//
// Serve una forma custom perché recharts arrotonderebbe entrambe le estremità
// (una colonna che galleggia invece di crescere da una linea di base) e non
// conosce il gap di superficie tra i segmenti di uno stack.

/**
 * Le props geometriche le inietta recharts, quindi arrivano opzionali: `segment`
 * è invece nostra, e dice quale dei due pezzi dello stack si sta disegnando.
 */
export interface ColumnShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  fillOpacity?: number;
  segment?: "confirmed" | "projected";
  payload?: { confirmedValue?: number; projectedValue?: number };
}

export default function ColumnShape(props: ColumnShapeProps) {
  const { x = 0, y = 0, width = 0, height = 0, fill, fillOpacity, segment, payload } = props;

  if (!(height > 0) || !(width > 0)) return null;

  const hasProjected = (payload?.projectedValue ?? 0) > 0;
  const hasConfirmed = (payload?.confirmedValue ?? 0) > 0;

  // Il pezzo in cima è l'estremità dei DATI: si arrotonda solo quella.
  const isTop = segment === "projected" ? true : !hasProjected;
  // Gap di superficie di 2px tra i due segmenti che si toccano.
  const gap = segment === "confirmed" && hasProjected && hasConfirmed ? 2 : 0;

  const h = Math.max(0.5, height - gap);
  const top = y + gap;
  const r = isTop ? clamp(4, 0, Math.min(width / 2, h)) : 0;

  const d = isTop
    ? `M${x},${top + h} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + width - r},${top} Q${x + width},${top} ${x + width},${top + r} L${x + width},${top + h} Z`
    : `M${x},${top + h} L${x},${top} L${x + width},${top} L${x + width},${top + h} Z`;

  return <path d={d} fill={fill} fillOpacity={fillOpacity} />;
}
