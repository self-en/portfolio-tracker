import type { ReactNode } from "react";
import type { TooltipContentProps, TooltipValueType } from "recharts";
import type { NameType } from "recharts/types/component/DefaultTooltipContent";

/**
 * Come si identifica una serie nel tooltip: un TRATTO del suo colore ("line", il
 * default) oppure un quadrotto ("rect") per le colonne in stack.
 */
export type KeyMark = "line" | "rect";

/**
 * Una riga di tooltip: `value` è GIÀ FORMATTATO (arriva da web/src/format.ts).
 * Qui non entrano importi grezzi - il tooltip non formatta, mostra.
 */
export interface TooltipRow {
  label: string;
  value: string;
  color: string;
  /** `strokeDasharray` della serie, per distinguere il proiettato dal certo. */
  dash?: string;
  mark?: KeyMark;
}

interface ChartTooltipProps {
  title?: string;
  rows: TooltipRow[];
  /** Avviso in evidenza (es. dati incompleti). */
  flag?: ReactNode;
}

/**
 * Le props che recharts passa a `<Tooltip content={...}>`.
 *
 * Si riusa il tipo di recharts invece di dichiararne uno più stretto: `content`
 * accetta solo una funzione che accetti QUESTO, e una firma più precisa non è
 * assegnabile.
 */
export type TooltipRenderProps = TooltipContentProps<TooltipValueType, NameType>;

/**
 * Il punto sotto il cursore, ristretto alla riga di `data` del grafico.
 *
 * recharts dichiara `payload[].payload` come `any`: questa funzione è l'UNICO
 * posto dove quel valore viene ristretto, così i tooltip non ripetono il cast.
 */
export function pointOf<P>({ active, payload }: TooltipRenderProps): P | null {
  if (!active || !payload || payload.length === 0) return null;
  return (payload[0]?.payload as P | undefined) ?? null;
}

// Tooltip condiviso.
//
// Il VALORE guida ed è l'elemento forte, l'etichetta della serie segue: è la
// gerarchia della legenda invertita, perché qui il lettore ha già la serie e
// vuole il numero.
//
// Le righe si identificano con un TRATTO del colore della serie, non con un
// quadrotto pieno: alla densità di un tooltip un box è inchiostro di peso-dato che
// fa il lavoro di un'etichetta.
//
// Le etichette sono dati non fidati (arrivano da nomi di strumento inseriti a
// mano): entrano nel DOM come testo React, mai come HTML.

function Key({ color, dash, mark }: Pick<TooltipRow, "color" | "dash" | "mark">) {
  if (mark === "rect") {
    return (
      <svg width="12" height="12" aria-hidden="true" focusable="false">
        <rect x="0" y="1" width="11" height="10" rx="2" fill={color} />
      </svg>
    );
  }
  return (
    <svg width="14" height="8" aria-hidden="true" focusable="false">
      <line
        x1="1"
        y1="4"
        x2="13"
        y2="4"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={dash || undefined}
      />
    </svg>
  );
}

/** `title` è la riga di intestazione: il valore sull'asse X. */
export default function ChartTooltip({ title, rows, flag }: ChartTooltipProps) {
  return (
    <div className="pt-tooltip" role="tooltip">
      {title ? <p className="pt-tooltip-title">{title}</p> : null}
      {rows.map((row, i) => (
        <div className="pt-tooltip-row" key={`${row.label}:${i}`}>
          <Key color={row.color} dash={row.dash} mark={row.mark} />
          <span className="pt-tooltip-label">{row.label}</span>
          <span className="pt-tooltip-value">{row.value}</span>
        </div>
      ))}
      {flag ? <p className="pt-tooltip-flag">{flag}</p> : null}
    </div>
  );
}
