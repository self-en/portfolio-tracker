import { DASH, money, num, pct, signedPct, toneOf } from "../format";
import type { Returns } from "../types";

interface ReturnsPanelProps {
  returns: Returns;
  disclaimer?: any;
}


// XIRR e TWR AFFIANCATI, con le spiegazioni che l'API già fornisce in `notes`.
//
// Sono due numeri, non un grafico: affiancarli su una scala comune non
// aggiungerebbe nulla, mentre la differenza tra i due È il contenuto (il timing
// dei versamenti) e va spiegata a parole.
//
// Il rendimento semplice resta un riferimento in fondo, mai la cifra principale:
// a livello di portafoglio con versamenti irregolari è fuorviante.

export default function ReturnsPanel({ returns, disclaimer }: ReturnsPanelProps) {
  if (!returns) return null;
  const ccy = returns.baseCcy || "EUR";
  const byYear = returns.byYear || [];

  return (
    <section className="card">
      <h2>Rendimenti</h2>

      <div className="pt-returns">
        <div className="pt-returns-cell">
          <span className="pt-tile-label">Il tuo rendimento — XIRR</span>
          <div className={`pt-returns-metric ${toneOf(returns.xirr)}`}>{pct(returns.xirr)}</div>
          <p className="pt-returns-note">{returns.notes?.xirr}</p>
          {returns.xirrMethod ? (
            <p className="pt-returns-note">Metodo di soluzione: {returns.xirrMethod}.</p>
          ) : null}
        </div>

        <div className="pt-returns-cell">
          <span className="pt-tile-label">TWR — dall'inizio</span>
          <div className={`pt-returns-metric ${toneOf(returns.twr?.total)}`}>
            {pct(returns.twr?.total)}
          </div>
          <p className="pt-returns-note">
            {returns.twr?.annualized != null
              ? `Annualizzato ${pct(returns.twr.annualized)} su ${num(returns.twr.days, 0)} giorni.`
              : "Periodo troppo breve per annualizzare."}{" "}
            {returns.notes?.twr}
          </p>
        </div>
      </div>

      <p className="pt-chart-note">
        Investito netto {money(returns.netInvested, ccy)} · valore corrente{" "}
        {money(returns.marketValue, ccy)} · rendimento semplice {pct(returns.simple)}, mostrato solo
        come riferimento.
      </p>

      {byYear.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
          <table className="table">
            <caption className="sr-only">Rendimento per anno</caption>
            <thead>
              <tr>
                <th scope="col">Anno</th>
                <th scope="col" className="num">TWR</th>
                <th scope="col" className="num">XIRR</th>
              </tr>
            </thead>
            <tbody>
              {byYear.map((y) => (
                <tr key={y.year}>
                  <th scope="row" style={{ fontWeight: 500 }}>{y.year}</th>
                  <td className={`num ${toneOf(y.twr)}`}>
                    {y.twr == null ? DASH : signedPct(y.twr)}
                  </td>
                  <td className={`num ${toneOf(y.xirr)}`}>
                    {y.xirr == null ? DASH : signedPct(y.xirr)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {disclaimer ? <p className="pt-disclaimer">{disclaimer}</p> : null}
    </section>
  );
}
