import { money, monthLabel, num } from "../format";
import type { Amount } from "../types";

/** Un mese della striscia: chiave "YYYY-MM", quanti eventi e il lordo. */
export interface MonthSummary {
  key: string;
  count: number;
  gross: Amount;
}

interface MonthGridProps {
  months?: MonthSummary[];
  baseCcy?: string;
  /** Mese corrente, evidenziato. */
  currentKey?: string | null;
}


// Striscia dei mesi della finestra: etichetta, numero di eventi, lordo del mese.
// Serve a saltare al gruppo giusto dell'agenda senza scorrere.
//
// NON è una heatmap e non colora i mesi per grandezza: la grandezza è già scritta
// in cifre, e con una dozzina di eventi sparsi una griglia colorata sarebbe la
// forma sbagliata (la domanda "è davvero un grafico?" manda questo caso su una
// lista). Il chip porta testo, il grafico a colonne accanto porta il confronto.

export default function MonthGrid({ months, baseCcy = "EUR", currentKey }: MonthGridProps) {
  if (!months || months.length === 0) return null;

  return (
    <nav className="pt-monthstrip" aria-label="Mesi con scadenze">
      {months.map((m) => (
        <a
          key={m.key}
          href={`#mese-${m.key}`}
          className={
            m.key === currentKey ? "pt-monthchip pt-monthchip--current" : "pt-monthchip"
          }
        >
          <span className="pt-monthchip-label" style={{ textTransform: "capitalize" }}>
            {monthLabel(m.key)}
          </span>
          <span className="pt-monthchip-value">
            {m.gross ? money(m.gross, baseCcy) : "—"}
          </span>
          <span className="pt-monthchip-label">
            {num(m.count, 0)} {m.count === 1 ? "evento" : "eventi"}
          </span>
        </a>
      ))}
    </nav>
  );
}
