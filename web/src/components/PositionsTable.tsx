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
            <th scope="col">Strumento</th>
            <th scope="col" className="num">Quantità</th>
            <th scope="col" className="num">Costo medio</th>
            <th scope="col" className="num">Prezzo</th>
            <th scope="col" className="num">Valore</th>
            <th scope="col" className="num">Peso</th>
            <th scope="col" className="num">Latente</th>
            <th scope="col" className="num">Latente %</th>
            <th scope="col" className="num">Realizzato</th>
            <th scope="col" className="num">Redditi netti</th>
            <th scope="col" className="num">Rateo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const inst = row.instrument || {};
            return (
              <tr key={inst.id}>
                <th scope="row" style={{ fontWeight: 500, textAlign: "left" }}>
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
                <td className="num">
                  <QuantityCell row={row} />
                </td>
                <td className="num">{num(row.avgCost, 4)}</td>
                <td className="num">
                  {num(row.price, 4)}
                  <span className="pt-cell-sub">
                    {row.priceDate ? date(row.priceDate) : "nessuna quotazione"}
                  </span>
                  {row.stale ? <StaleBadge stale /> : null}
                </td>
                <td className="num">{money(row.marketValueBase, baseCcy)}</td>
                <td className="num">{pct(row.weight, 1)}</td>
                <td className={`num ${toneOf(row.unrealizedPnl)}`}>
                  {signedMoney(row.unrealizedPnl, baseCcy)}
                </td>
                <td className={`num ${toneOf(row.unrealizedPnlPct)}`}>
                  {signedPct(row.unrealizedPnlPct)}
                </td>
                <td className={`num ${toneOf(row.realizedPnl)}`}>
                  {signedMoney(row.realizedPnl, baseCcy)}
                </td>
                <td className="num">
                  {money(row.incomeNet, baseCcy)}
                  <span className="pt-cell-sub">lordo {money(row.incomeGross, baseCcy)}</span>
                </td>
                <td className="num">{money(row.accruedInterest, baseCcy)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
