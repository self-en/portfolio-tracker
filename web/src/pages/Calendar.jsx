import EmptyState from "../components/EmptyState.jsx";

// Fase 9: calendario dei redditi attesi e incassati, raggruppato per mese
// (monthLabel), con cedole PROJECTED generate dallo scadenzario e dividendi
// stimati; totale per mese e per anno, e distinzione tra lordo, ritenuta e netto.
export default function Calendar() {
  return (
    <>
      <h1>Calendario</h1>
      <EmptyState
        title="Nessuna scadenza in programma"
        message="Il calendario di cedole e dividendi arriverà con la gestione dei redditi."
      />
    </>
  );
}
