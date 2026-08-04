import { useQuery } from "@tanstack/react-query";
import { get } from "../api.js";
import { useApp } from "../AppContext.jsx";
import { date } from "../format.js";
import EmptyState from "../components/EmptyState.jsx";
import Spinner from "../components/Spinner.jsx";
import StaleBadge from "../components/StaleBadge.jsx";
import WarningsBanner from "../components/WarningsBanner.jsx";
import KpiRow from "../components/KpiRow.jsx";
import PositionsTable from "../components/PositionsTable.jsx";
import ReturnsPanel from "../components/ReturnsPanel.jsx";
import ValueSeriesChart from "../charts/ValueSeriesChart.jsx";
import AllocationBar from "../charts/AllocationBar.jsx";
import "../charts/charts.css";

// La finestra temporale del contesto usa le etichette italiane ("1A", "MAX");
// l'enum del server è quello di src/http/schemas.js. La traduzione vive qui, al
// confine, perché nessuno dei due lati appartiene a questa fase.
const RANGE_TO_API = { "1M": "1M", "3M": "3M", "6M": "6M", YTD: "YTD", "1A": "1Y", MAX: "ALL" };

export default function Dashboard() {
  const { portfolioId, range } = useApp();
  const apiRange = RANGE_TO_API[range] || "1Y";
  const scope = { portfolioId: portfolioId || undefined };

  // Le chiavi iniziano tutte con "portfolio": la conferma di un evento del
  // calendario invalida quel prefisso in blocco.
  const summary = useQuery({
    queryKey: ["portfolio", "summary", portfolioId],
    queryFn: () => get("/portfolio/summary", { query: scope }),
  });

  const series = useQuery({
    queryKey: ["portfolio", "value-series", portfolioId, apiRange],
    queryFn: () => get("/portfolio/value-series", { query: { ...scope, range: apiRange } }),
  });

  const positions = useQuery({
    queryKey: ["portfolio", "positions", portfolioId],
    queryFn: () => get("/portfolio/positions", { query: scope }),
  });

  const byAssetClass = useQuery({
    queryKey: ["portfolio", "allocation", portfolioId, "assetClass"],
    queryFn: () => get("/portfolio/allocation", { query: { ...scope, by: "assetClass" } }),
  });

  const byCurrency = useQuery({
    queryKey: ["portfolio", "allocation", portfolioId, "currency"],
    queryFn: () => get("/portfolio/allocation", { query: { ...scope, by: "currency" } }),
  });

  const returns = useQuery({
    queryKey: ["portfolio", "returns", portfolioId, apiRange],
    queryFn: () => get("/portfolio/returns", { query: { ...scope, range: apiRange } }),
  });

  if (summary.isPending) {
    return (
      <>
        <h1>Dashboard</h1>
        <Spinner label="Calcolo del portafoglio…" />
      </>
    );
  }

  if (summary.error) {
    return (
      <>
        <h1>Dashboard</h1>
        <EmptyState
          title="Sintesi non disponibile"
          message={summary.error.message}
          action={
            <button type="button" className="btn" onClick={() => summary.refetch()}>
              Riprova
            </button>
          }
        />
      </>
    );
  }

  const data = summary.data;
  const ccy = data.baseCcy || "EUR";
  const positionItems = positions.data?.items ?? [];

  return (
    <>
      <div className="pt-section-head">
        <h1>Dashboard</h1>
        <div className="row">
          <StaleBadge stale={data.stale} />
          <span className="muted small">dati al {date(data.asOf)}</span>
        </div>
      </div>

      <WarningsBanner warnings={data.warnings} />

      <KpiRow summary={data} points={series.data?.points} />

      {series.isPending ? (
        <div className="card">
          <Spinner label="Costruzione della serie storica…" />
        </div>
      ) : series.error ? (
        <EmptyState title="Serie storica non disponibile" message={series.error.message} />
      ) : (
        <div className="pt-stack">
          <ValueSeriesChart
            points={series.data.points}
            meta={series.data.meta}
            refetching={series.isFetching}
          />
          <WarningsBanner warnings={series.data.meta?.warnings} />
        </div>
      )}

      <div className="pt-cols">
        {byAssetClass.data ? (
          <AllocationBar
            title="Ripartizione per classe di attivo"
            subtitle={`Peso sul valore di mercato, importi in ${byAssetClass.data.baseCcy || ccy}`}
            items={byAssetClass.data.items}
            baseCcy={byAssetClass.data.baseCcy || ccy}
            refetching={byAssetClass.isFetching}
          />
        ) : null}
        {byCurrency.data ? (
          <AllocationBar
            title="Ripartizione per valuta"
            subtitle="Esposizione valutaria del portafoglio"
            items={byCurrency.data.items}
            baseCcy={byCurrency.data.baseCcy || ccy}
            refetching={byCurrency.isFetching}
          />
        ) : null}
      </div>

      {/* La tabella delle posizioni è SEMPRE in pagina: è metà della regola di
          rimedio che il WARN di contrasto della palette chiara rende
          obbligatoria (l'altra metà sono le etichette dirette sui segmenti). */}
      <section className="pt-stack">
        <div className="pt-section-head">
          <h2>Posizioni</h2>
          <span className="muted small">
            Realizzato, redditi e plusvalenza latente sono tre voci separate: non vanno sommate in
            un unico profitto.
          </span>
        </div>
        {positions.isPending ? (
          <Spinner label="Caricamento posizioni…" />
        ) : positions.error ? (
          <EmptyState title="Posizioni non disponibili" message={positions.error.message} />
        ) : positionItems.length > 0 ? (
          <PositionsTable
            items={positionItems}
            baseCcy={positions.data.baseCcy || ccy}
            asOf={positions.data.asOf}
          />
        ) : (
          <EmptyState
            title="Nessuna posizione"
            message="Registra un acquisto dalla pagina Movimenti e la dashboard si popola."
          />
        )}
      </section>

      {returns.data ? (
        <ReturnsPanel returns={returns.data} disclaimer={data.disclaimer} />
      ) : returns.error ? (
        <EmptyState title="Rendimenti non disponibili" message={returns.error.message} />
      ) : null}
    </>
  );
}
