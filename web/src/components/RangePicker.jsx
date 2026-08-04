// Intervallo di date: due campi data più le scorciatoie usate di fatto.
//
// Tutta l'aritmetica sulle date lavora su stringhe "YYYY-MM-DD" con Date.UTC
// (docs/decisions.md §6): un Date in fuso locale, a ovest di Greenwich, farebbe
// scivolare "oggi" al giorno prima.

function iso(dateUtc) {
  return dateUtc.toISOString().slice(0, 10);
}

function today() {
  const now = new Date();
  return iso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

function minusMonths(isoDate, months) {
  const [y, m, d] = isoDate.split("-").map(Number);
  // Il giorno 31 in un mese da 30 rientrerebbe nel mese successivo: si limita al
  // numero di giorni del mese di arrivo.
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay))));
}

const PRESETS = [
  { id: "1M", label: "1M", from: () => minusMonths(today(), 1) },
  { id: "3M", label: "3M", from: () => minusMonths(today(), 3) },
  { id: "6M", label: "6M", from: () => minusMonths(today(), 6) },
  { id: "YTD", label: "YTD", from: () => `${today().slice(0, 4)}-01-01` },
  { id: "1A", label: "1A", from: () => minusMonths(today(), 12) },
  { id: "MAX", label: "Tutto", from: () => null },
];

export default function RangePicker({ from, to, onChange, legend = "Intervallo" }) {
  const apply = (preset) => {
    const start = preset.from();
    onChange({ from: start, to: start ? today() : null });
  };

  // Il preset attivo si riconosce ricalcolandolo: nessuno stato duplicato che possa
  // andare fuori sincrono con i due campi data.
  const activeId = PRESETS.find((p) => {
    const start = p.from();
    if (!start) return !from && !to;
    return from === start && to === today();
  })?.id;

  return (
    <fieldset className="range-picker">
      <legend className="field-label">{legend}</legend>
      <div className="range-presets">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={activeId === p.id ? "btn btn--small btn--chip-active" : "btn btn--small"}
            onClick={() => apply(p)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="range-dates">
        <label className="field field--inline">
          <span className="field-label">Da</span>
          <input
            className="input"
            type="date"
            value={from ?? ""}
            max={to || undefined}
            onChange={(e) => onChange({ from: e.target.value || null, to })}
          />
        </label>
        <label className="field field--inline">
          <span className="field-label">A</span>
          <input
            className="input"
            type="date"
            value={to ?? ""}
            min={from || undefined}
            onChange={(e) => onChange({ from, to: e.target.value || null })}
          />
        </label>
      </div>
    </fieldset>
  );
}

export { today, minusMonths };
