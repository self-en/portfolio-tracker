import EmptyState from "../components/EmptyState.jsx";

// Fase 7: elenco dei movimenti con filtri (strumento, tipo, intervallo di date),
// paginazione, e form di inserimento/modifica. Ogni campo di importo e di
// quantità è type="text" inputMode="decimal" legato a una stringa: la quantità è
// sempre positiva, la direzione sta nel tipo di movimento.
export default function Movements() {
  return (
    <>
      <h1>Movimenti</h1>
      <EmptyState
        title="Nessun movimento"
        message="L'elenco dei movimenti e il form di inserimento arriveranno con la gestione delle transazioni."
      />
    </>
  );
}
