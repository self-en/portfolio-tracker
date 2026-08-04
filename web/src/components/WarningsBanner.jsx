// I warning del server portano sempre un `code`, non sempre un `message`
// (`/api/system/status` manda solo code + details): il testo per l'utente vive
// qui, così un codice nuovo degrada nel proprio codice invece di sparire.
const TESTI = {
  not_configured: "Configurazione incompleta: alcune funzioni sono disattivate.",
  db_unavailable: "Database non raggiungibile: i dati mostrati possono essere incompleti.",
  migration_checksum_mismatch:
    "Una migrazione già applicata è stata modificata: lo schema del database potrebbe non corrispondere al codice.",
  partial:
    "Serie storica incompleta: per alcune date manca il prezzo e il contributo dello strumento è escluso, non azzerato.",
  missing_price: "Prezzo mancante per uno o più strumenti: la valorizzazione è parziale.",
  oversell:
    "Vendita superiore alla quantità in carico: la quantità è stata limitata al disponibile.",
  fx_missing: "Tasso di cambio mancante per una o più date: usato l'ultimo disponibile.",
  upstream_error: "Il fornitore dei prezzi non ha risposto: i dati possono essere vecchi.",
};

function testo(w) {
  return w.message || TESTI[w.code] || `Avviso: ${w.code}`;
}

export default function WarningsBanner({ warnings }) {
  if (!Array.isArray(warnings) || warnings.length === 0) return null;

  return (
    <div className="warnings" role="status">
      <ul className="warnings-list">
        {warnings.map((w, i) => (
          <li key={`${w.code}:${i}`} className="warnings-item">
            <span className="warnings-code">{w.code}</span>
            <span>{testo(w)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
