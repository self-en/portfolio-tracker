import { useParams } from "react-router-dom";
import EmptyState from "../components/EmptyState.jsx";

// Fase 8: dettaglio dello strumento — posizione corrente (quantità, costo medio,
// valore), grafico del prezzo sul range scelto, movimenti collegati, scadenzario
// cedolare per le obbligazioni e rateo in corso riportato a parte rispetto al
// corso secco.
export default function InstrumentDetail() {
  const { id } = useParams();
  return (
    <>
      <h1>Strumento {id}</h1>
      <EmptyState
        title="Dettaglio non disponibile"
        message="Grafico del prezzo, posizione e scadenzario cedolare arriveranno con la pagina di dettaglio."
      />
    </>
  );
}
