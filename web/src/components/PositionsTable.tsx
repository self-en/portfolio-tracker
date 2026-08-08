import { Link } from "react-router-dom";
import StaleBadge from "./StaleBadge";
import { DASH, date, money, num, pct, qty, signedMoney, signedPct, toneOf } from "../format";
import type { PositionRow, Warning } from "../types";

interface PositionsTableProps {
  items?: PositionRow[];
  baseCcy?: string;
  asOf?: string | null;
}


// TABELLA DELLE POSIZIONI.
//
// È in pagina sempre, e non per completezza: è metà della REGOLA DI RIMEDIO che
// il WARN di contrasto della palette chiara rende obbligatoria (l'altra metà sono
// le etichette dirette sui segmenti dell'allocazione). Serve anche da vista
// tabellare della ripartizione.
//
// REALIZZATO, REDDITI e LATENTE restano TRE COLONNE SEPARATE. Non vengono mai
// sommate in un "profitto" unico: il trattamento fiscale italiano differisce per
// involucro, le plusvalenze da ETF non compensano le minus da redditi diversi e
// il rateo cedolare è reddito, non capital gain (docs/decisions.md §3).

/** Una colonna: `optional` sparisce sotto i 640px, dove le righe sono schede. */
interface Col {
  label: string;
  className?: string;
  optional?: boolean;
}

// Le colonne in un posto solo, come già fa DataTable: l'intestazione e il
// `data-label` della cella DEVONO essere la stessa stringa, perché sotto i 640px
// la riga diventa una scheda e l'etichetta di ogni valore è quel data-label. Con
// le stringhe scritte in due punti la scheda mentirebbe alla prima modifica.
//
// Costo medio, Realizzato e Rateo sono `optional`: su telefono sono le tre voci
// ridondanti (il carico si legge dal latente, il realizzato dal dettaglio
// strumento), e togliendole la scheda scende da 11 righe a 8. Su desktop restano.
const COLS: Col[] = [
  { label: "Strumento" },
  { label: "Quantità", className: "num" },
  { label: "Costo medio", className: "num", optional: true },
  { label: "Prezzo", className: "num" },
  { label: "Valore", className: "num" },
  { label: "Peso", className: "num" },
  { label: "Latente", className: "num" },
  { label: "Latente %", className: "num" },
  { label: "Realizzato", className: "num", optional: true },
  { label: "Redditi netti", className: "num" },
  { label: "Rateo", className: "num", optional: true },
];

/** Classe e `data-label` di una cella, presi dalla colonna omonima. */
function cell(label: string, tone?: string) {
  const col = COLS.find((c) => c.label === label);
  return {
    className:
      [col?.className, col?.optional ? "cell-optional" : "", tone].filter(Boolean).join(" ") ||
      undefined,
    "data-label": label,
  };
}

// Come in WarningsBanner: la chiave arriva dal server, quindi un codice non
// previsto qui degrada nel proprio codice invece di essere un errore di tipo.
const WARNING_LABELS: Record<string, string> = {
  price_missing: "prezzo mancante",
  missing_price: "prezzo mancante",
  fx_missing: "cambio mancante",
  oversell: "vendita oltre il carico",
  partial: "dati incompleti",
};

function RowWarnings({ warnings }: { warnings?: Warning[] }) {
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  return (
    <span className="pt-rowbadges">
      {warnings.map((w, i) => (
        <span
          key={`${w.code}:${i}`}
          className="badge badge--stale"
          title={w.message || w.code}
        >
          {WARNING_LABELS[w.code] || w.code}
        </span>
      ))}
    </span>
  );
}

/** Quantità: per i bond si mostra il NOMINALE, che è ciò che scrive il broker. */
function QuantityCell({ row }: { row: PositionRow }) {
  const isBond = row.instrument?.quoteConvention === "PCT_OF_NOMINAL";
  if (isBond && row.nominal) {
    return (
      <>
        {num(row.nominal, 2)}
        <span className="pt-cell-sub">nominale · {qty(row.quantity)} titoli</span>
      </>
    );
  }
  return <>{qty(row.quantity)}</>;
}

export default function PositionsTable({ items, baseCcy = "EUR", asOf }: PositionsTableProps) {
  const rows = items || [];

  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">
          Posizioni al {date(asOf)}. Plusvalenza realizzata, redditi e plusvalenza latente sono tre
          colonne separate e non vanno sommate.
        </caption>
        <thead>
          <tr>
            {COLS.map((c) => (
              <th
                key={c.label}
                scope="col"
                className={
                  [c.className, c.optional ? "cell-optional" : ""].filter(Boolean).join(" ") ||
                  undefined
                }
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const inst = row.instrument || {};
            return (
              <tr key={inst.id}>
                {/* `scope="row"` resta: è la cella che identifica la posizione per
                    lo screen reader. Lo stile inline diventa una classe, così la
                    trasformazione in scheda può intervenire sulla cella. */}
                <th scope="row" className="cell-rowhead" data-label="Strumento">
                  {inst.id ? (
                    <Link to={`/strumenti/${inst.id}`}>{inst.name || inst.ticker || inst.isin}</Link>
                  ) : (
                    inst.name || DASH
                  )}
                  <RowWarnings warnings={row.warnings} />
                  <span className="pt-cell-sub">
                    {[inst.ticker, inst.isin, inst.currency].filter(Boolean).join(" · ")}
                  </span>
                </th>
                <td {...cell("Quantità")}>
                  <QuantityCell row={row} />
                </td>
                <td {...cell("Costo medio")}>{num(row.avgCost, 4)}</td>
                <td {...cell("Prezzo")}>
                  {num(row.price, 4)}
                  <span className="pt-cell-sub">
                    {row.priceDate ? date(row.priceDate) : "nessuna quotazione"}
                  </span>
                  {row.stale ? <StaleBadge stale /> : null}
                </td>
                <td {...cell("Valore")}>{money(row.marketValueBase, baseCcy)}</td>
                <td {...cell("Peso")}>{pct(row.weight, 1)}</td>
                <td {...cell("Latente", toneOf(row.unrealizedPnl))}>
                  {signedMoney(row.unrealizedPnl, baseCcy)}
                </td>
                <td {...cell("Latente %", toneOf(row.unrealizedPnlPct))}>
                  {signedPct(row.unrealizedPnlPct)}
                </td>
                <td {...cell("Realizzato", toneOf(row.realizedPnl))}>
                  {signedMoney(row.realizedPnl, baseCcy)}
                </td>
                <td {...cell("Redditi netti")}>
                  {money(row.incomeNet, baseCcy)}
                  <span className="pt-cell-sub">lordo {money(row.incomeGross, baseCcy)}</span>
                </td>
                <td {...cell("Rateo")}>{money(row.accruedInterest, baseCcy)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
