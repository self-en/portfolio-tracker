import type { PositionRow } from "../types";

interface ChartTooltipProps {
  title: string;
  rows: PositionRow[];
  flag?: any;
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

function Key({ color, dash, mark }) {
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

/**
 * @param {object} props
 * @param {string} props.title riga di intestazione (la X)
 * @param {Array<{label: string, value: string, color: string, dash?: string, mark?: string}>} props.rows
 * @param {string} [props.flag] avviso in evidenza (es. dati incompleti)
 */
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
