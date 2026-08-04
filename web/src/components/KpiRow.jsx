import { money, pct, signedMoney, signedPct } from "../format.js";
import Sparkline from "./Sparkline.jsx";
import StatTile from "./StatTile.jsx";

// I QUATTRO NUMERI DI TESTA — quattro tessere, non un grafico a quattro barre.
//
// Una manciata di numeri di testata è una riga di KPI: un grafico a barre
// costringerebbe a leggere quattro grandezze incommensurabili (euro, euro,
// percentuale, euro) su un asse comune che non esiste.
//
// Una sola cifra eroe per vista: il valore di mercato.

/**
 * @param {object} props
 * @param {object} props.summary risposta di GET /api/portfolio/summary
 * @param {Array} [props.points] punti di /value-series, per la sparkline
 */
export default function KpiRow({ summary, points }) {
  const ccy = summary.baseCcy || "EUR";
  const values = (points || []).map((p) => p.value);

  return (
    <div className="pt-kpi">
      <StatTile
        hero
        label="Valore di mercato"
        value={money(summary.totalValue, ccy)}
        delta={signedMoney(summary.dayChange, ccy)}
        deltaSource={summary.dayChange}
        deltaLabel={`(${signedPct(summary.dayChangePct)}) da ieri`}
        sub={
          summary.accruedInterest && summary.accruedInterest !== "0.00"
            ? `di cui rateo cedolare ${money(summary.accruedInterest, ccy)}, escluso dal totale`
            : `${summary.positionsCount ?? 0} posizioni aperte`
        }
        spark={
          <Sparkline
            values={values}
            label={`Andamento del valore di mercato, ultimo dato ${money(summary.totalValue, ccy)}`}
          />
        }
      />

      <StatTile
        label="Plusvalenza latente"
        value={signedMoney(summary.unrealizedPnl, ccy)}
        delta={signedPct(summary.unrealizedPnlPct)}
        deltaSource={summary.unrealizedPnlPct}
        deltaLabel="sul costo di carico"
        sub={`Costo di carico ${money(summary.costBasis, ccy)}`}
      />

      {/* Lo XIRR come percentuale PRINCIPALE: risponde a "quanto hanno reso i
          miei soldi", che è la domanda di chi versa a importi irregolari. */}
      <StatTile
        label="Il tuo rendimento (XIRR)"
        value={pct(summary.xirr)}
        delta={summary.twr?.total ? signedPct(summary.twr.total) : undefined}
        deltaSource={summary.twr?.total}
        deltaLabel="TWR dall'inizio"
        sub="Annualizzato, pesato per il tempo di permanenza dei versamenti"
      />

      <StatTile
        label="Redditi netti incassati"
        value={money(summary.incomeNet, ccy)}
        sub={
          <>
            Lordo {money(summary.incomeGross, ccy)} · ritenuta{" "}
            {money(summary.taxWithheld, ccy)}
            <br />
            Realizzato {signedMoney(summary.realizedPnl, ccy)}, voce separata
          </>
        }
      />
    </div>
  );
}
