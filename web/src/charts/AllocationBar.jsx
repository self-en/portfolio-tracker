import { useMemo, useRef, useState } from "react";
import { money, pct } from "../format.js";
import ChartFrame from "./ChartFrame.jsx";
import ChartTooltip from "./ChartTooltip.jsx";
import useChartTheme from "./useChartTheme.js";
import useElementWidth from "./useElementWidth.js";
import { textOnFill } from "./contrast.js";
import { textWidth } from "./textWidth.js";
import { toNumberOrZero } from "./numbers.js";

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
}) {
  const theme = useChartTheme();
  const barRef = useRef(null);
  const barWidth = useElementWidth(barRef);
  const [hover, setHover] = useState(null);

  const rows = useMemo(() => {
    const list = (items || []).filter((it) => toNumberOrZero(it.weight) > 0);
    const gaps = Math.max(0, list.length - 1) * SEGMENT_GAP;
    const usable = Math.max(0, barWidth - gaps);

    return list.map((it, i) => {
      const weight = toNumberOrZero(it.weight);
      const widthPx = usable * weight;
      const fits = (candidate) =>
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

  const hovered = hover === null ? null : rows.find((r) => r.index === hover) ?? null;

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
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td className="num">{money(r.marketValue, baseCcy)}</td>
              <td className="num">{pct(r.weightRaw)}</td>
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
        mark: "rect",
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
            onPointerEnter={() => setHover(r.index)}
            onPointerLeave={() => setHover((cur) => (cur === r.index ? null : cur))}
            onFocus={() => setHover(r.index)}
            onBlur={() => setHover((cur) => (cur === r.index ? null : cur))}
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
            {hovered !== null && hovered.index === r.index ? (
              <span className="pt-allocbar-tip">
                <ChartTooltip
                  title={r.label}
                  rows={[
                    {
                      label: "Valore",
                      value: money(r.marketValue, baseCcy),
                      color: r.color,
                      mark: "rect",
                    },
                    { label: "Peso", value: pct(r.weightRaw), color: r.color, mark: "rect" },
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
