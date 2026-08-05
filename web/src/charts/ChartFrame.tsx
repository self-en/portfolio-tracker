import ChartLegend from "./ChartLegend";
import type { ReactNode } from "react";

interface ChartFrameProps {
  title: string;
  subtitle?: any;
  legend?: any;
  badges?: any;
  note?: any;
  table?: any;
  refetching?: boolean;
  children?: ReactNode;
}


// Contenitore di ogni grafico: <figure> con titolo, sottotitolo, badge di stato,
// legenda, area di disegno e la VISTA TABELLARE, che è il gemello accessibile di
// qualunque grafico — nessun valore è raggiungibile solo passandoci sopra col
// mouse.
//
// Nessuna altezza fissa che escluda la fascia dell'asse x: il contenitore cresce
// col contenuto, così la card non sviluppa uno scroll verticale annidato.

/**
 * @param {object} props
 * @param {string} props.title
 * @param {string} [props.subtitle]
 * @param {Array} [props.legend] voci per ChartLegend; ometti con una serie sola
 * @param {import("react").ReactNode} [props.badges]
 * @param {import("react").ReactNode} [props.note]
 * @param {import("react").ReactNode} [props.table] contenuto della vista tabellare
 * @param {boolean} [props.refetching] tiene il render precedente a opacità ridotta
 */
export default function ChartFrame({
  title,
  subtitle,
  legend,
  badges,
  note,
  table,
  refetching = false,
  children,
}: ChartFrameProps) {
  return (
    <figure className="pt-chart">
      <div className="pt-chart-head">
        <div>
          <h2 className="pt-chart-title">{title}</h2>
          {subtitle ? <p className="pt-chart-sub">{subtitle}</p> : null}
        </div>
        {badges ? <div className="pt-chart-badges">{badges}</div> : null}
      </div>

      {legend && legend.length > 0 ? <ChartLegend items={legend} /> : null}

      <div className={refetching ? "pt-plot pt-plot--refetching" : "pt-plot"}>{children}</div>

      {note ? <figcaption className="pt-chart-note">{note}</figcaption> : null}

      {table ? (
        <details className="pt-tableview">
          <summary>Vista tabellare</summary>
          {table}
        </details>
      ) : null}
    </figure>
  );
}
