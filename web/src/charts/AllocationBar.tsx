import { useMemo, useRef, useState } from "react";
import { money, pct } from "../format";
import ChartFrame from "./ChartFrame";
import ChartTooltip from "./ChartTooltip";
import useChartTheme from "./useChartTheme";
import useElementWidth from "./useElementWidth";
import { textOnFill } from "./contrast";
import { textWidth } from "./textWidth";
import { toNumberOrZero } from "./numbers";
import type { AllocationGroup } from "../types";
import type { ReactNode } from "react";

interface AllocationBarProps {
  items?: AllocationGroup[];
  baseCcy?: string;
  title: string;
  subtitle?: ReactNode;
  refetching?: boolean;
}


// RIPARTIZIONE — barra orizzontale in STACK, non una torta.
//
// Parte-sul-tutto con nomi di categoria lunghi in italiano ("Non classificato",
// "Obbligazioni governative"): una torta costringerebbe a confrontare angoli in
// senso orario, mentre una barra orizzontale lascia i nomi scritti per esteso e
// mette i segmenti su una linea di base comune.
//
// REGOLA DI RIMEDIO: in modalità chiara aqua, giallo e magenta stanno sotto 3:1
// sulla superficie (WARN del validator, che la skill rende non ignorabile). Il
// rimedio va fornito DUE volte e qui lo è: etichette dirette sui segmenti —
// stampate solo dove misurano di starci, mai tagliate — e la tabella delle
// posizioni, che è sempre in pagina.
//
// Mai una nona tinta: l'API accorpa già la coda in "Altro" e series(i) fuori
// range restituisce il colore muted invece di ciclare.

const LABEL_FONT = "600 12.5px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const SEGMENT_GAP = 2;
const LABEL_PADDING = 8;

export default function AllocationBar({
  items,
  baseCcy = "EUR",
  title,
  subtitle,
  refetching = false,
}: AllocationBarProps) {
  const theme = useChartTheme();
  const barRef = useRef<HTMLDivElement>(null);
  const barWidth = useElementWidth(barRef);
  // L'indice del segmento sotto il puntatore (o col focus), non il segmento: è
  // ciò che gli handler qui sotto confrontano.
  const [hover, setHover] = useState<number | null>(null);
  // E l'indice del segmento aperto con un TOCCO. Due stati e non uno: in un tap
  // arrivano pointerenter, focus, click e pointerleave dentro lo stesso gesto,
  // quindi un unico stato si aprirebbe e si richiuderebbe da solo. `pinned`
  // sopravvive al pointerleave, `hover` no.
  const [pinned, setPinned] = useState<number | null>(null);

  const rows = useMemo(() => {
    const list = (items || []).filter((it) => toNumberOrZero(it.weight) > 0);
    const gaps = Math.max(0, list.length - 1) * SEGMENT_GAP;
    const usable = Math.max(0, barWidth - gaps);

    return list.map((it, i) => {
      const weight = toNumberOrZero(it.weight);
      const widthPx = usable * weight;
      const fits = (candidate: string) =>
        textWidth(candidate, LABEL_FONT) + LABEL_PADDING * 2 <= widthPx;
      // Dal più informativo al meno: nome + peso, nome, solo peso. Se nemmeno il
      // peso entra, l'etichetta salta e il valore resta raggiungibile da
      // legenda, tooltip e vista tabellare.
      const inline =
        [`${it.label} · ${pct(it.weight, 0)}`, it.label, pct(it.weight, 0)].find(fits) ?? null;

      return {
        key: it.key,
        label: it.label,
        marketValue: it.marketValue,
        weightRaw: it.weight,
        weight,
        color: theme.series(i),
        inline,
        index: i,
      };
    });
  }, [items, barWidth, theme]);

  const shownIndex = pinned ?? hover;
  const shown = shownIndex === null ? null : rows.find((r) => r.index === shownIndex) ?? null;

  const table = (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            <th scope="col">Categoria</th>
            <th scope="col" className="num">
              Valore
            </th>
            <th scope="col" className="num">
              Peso
            </th>
          </tr>
        </thead>
        <tbody>
          {/* data-label ripete l'intestazione: sotto i 640px la riga diventa una
              scheda e senza di esso resterebbe una colonna di numeri anonimi. */}
          {rows.map((r) => (
            <tr key={r.key}>
              <td data-label="Categoria">{r.label}</td>
              <td className="num" data-label="Valore">
                {money(r.marketValue, baseCcy)}
              </td>
              <td className="num" data-label="Peso">
                {pct(r.weightRaw)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (rows.length === 0) {
    return (
      <ChartFrame title={title} subtitle={subtitle} refetching={refetching}>
        <div className="pt-allocbar-empty" />
        <p className="pt-chart-note">Nessuna posizione da ripartire.</p>
      </ChartFrame>
    );
  }

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      // I segmenti SONO categorie distinte: la legenda c'è sempre, e porta i nomi
      // completi anche dove il segmento è troppo stretto per stamparli.
      legend={rows.map((r) => ({
        label: r.label,
        color: r.color,
        mark: "rect" as const,
        note: pct(r.weightRaw, 1),
      }))}
      refetching={refetching}
      note="Le etichette sono stampate direttamente sui segmenti che le contengono per intero; per gli altri il nome sta in legenda, nel tooltip e nella vista tabellare."
      table={table}
    >
      <div className="pt-allocbar" ref={barRef} role="list" aria-label={title}>
        {rows.map((r) => (
          <button
            type="button"
            key={r.key}
            className="pt-allocbar-seg"
            style={{ flexGrow: r.weight, flexBasis: 0, background: r.color }}
            // Il tooltip arricchisce, non fa da cancello: lo stesso contenuto
            // compare col focus da tastiera, e i valori sono comunque in tabella.
            onPointerEnter={() => {
              setHover(r.index);
              // Passando su un ALTRO segmento il tooltip fissato col tocco si
              // sgancia, altrimenti resterebbe appeso al segmento di prima.
              setPinned((cur) => (cur === r.index ? cur : null));
            }}
            onPointerLeave={() => setHover((cur) => (cur === r.index ? null : cur))}
            onFocus={() => setHover(r.index)}
            onBlur={() => {
              setHover((cur) => (cur === r.index ? null : cur));
              setPinned((cur) => (cur === r.index ? null : cur));
            }}
            // Un tocco rivela, un secondo nasconde. Le proporzioni non si toccano:
            // per i segmenti da 3px la via principale restano la legenda e la
            // vista tabellare, che ci sono sempre.
            onClick={() => setPinned((cur) => (cur === r.index ? null : r.index))}
            aria-label={`${r.label}: ${money(r.marketValue, baseCcy)}, ${pct(r.weightRaw)}`}
          >
            {r.inline ? (
              <span
                className="pt-allocbar-label"
                // Unica eccezione al "testo in token di TESTO": un'etichetta
                // stampata dentro una campitura prende inchiostro o superficie
                // secondo la luminanza del riempimento, così supera sempre il
                // contrasto.
                style={{ color: textOnFill(r.color, theme) }}
              >
                {r.inline}
              </span>
            ) : null}
            {shown !== null && shown.index === r.index ? (
              <span className="pt-allocbar-tip">
                <ChartTooltip
                  title={r.label}
                  rows={[
                    {
                      label: "Valore",
                      value: money(r.marketValue, baseCcy),
                      color: r.color,
                      mark: "rect" as const,
                    },
                    {
                      label: "Peso",
                      value: pct(r.weightRaw),
                      color: r.color,
                      mark: "rect" as const,
                    },
                  ]}
                />
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </ChartFrame>
  );
}
