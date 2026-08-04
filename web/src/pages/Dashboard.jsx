import EmptyState from "../components/EmptyState.jsx";

// Fase 8: KPI di portafoglio (valore, costo, plusvalenza latente, realizzato,
// redditi — tre voci separate, mai sommate), grafico del valore nel tempo con i
// segmenti parziali tratteggiati, ripartizione per asset class e per valuta,
// StaleBadge sull'ultimo refresh prezzi e WarningsBanner sui warning della
// risposta. Legge portfolioId e range da AppContext.
export default function Dashboard() {
  return (
    <>
      <h1>Dashboard</h1>
      <EmptyState
        title="Nessun dato da mostrare"
        message="La sintesi del portafoglio arriverà con i grafici e gli indicatori."
      />
    </>
  );
}
