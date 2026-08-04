import EmptyState from "../components/EmptyState.jsx";

// Fase 7: elenco degli strumenti con ricerca, creazione e modifica. Il form
// mostra i campi obbligazionari (scadenza, cedola come frazione annua, valore
// nominale, convenzione di quotazione) solo per gli strumenti di tipo BOND, e il
// prezzo manuale per quelli senza copertura del provider.
export default function Instruments() {
  return (
    <>
      <h1>Strumenti</h1>
      <EmptyState
        title="Nessuno strumento"
        message="L'anagrafica degli strumenti arriverà con la gestione dei dati di base."
      />
    </>
  );
}
