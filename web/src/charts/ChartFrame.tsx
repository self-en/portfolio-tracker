import ChartLegend from "./ChartLegend";
import type { LegendItems } from "./ChartLegend";
import type { ReactNode } from "react";

interface ChartFrameProps {
  title: string;
  subtitle?: ReactNode;
  /** Voci per ChartLegend; ometti con una serie sola. */
  legend?: LegendItems;
  badges?: ReactNode;
  note?: ReactNode;
  /** Contenuto della vista tabellare. */
  table?: ReactNode;
  /** Tiene il render precedente a opacità ridotta. */
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
