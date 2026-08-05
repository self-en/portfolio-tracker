import RangePicker from "./RangePicker";

interface TypeBadgeProps {
  type?: any;
}

interface FilterBarProps {
  value: string | null;
  onChange?: (...args: any[]) => void;
  instruments?: any[];
  instrumentsError?: any;
}


// Vocabolario dei tipi di movimento: etichette italiane, tono per il badge e
// gruppi. Vive qui perché è la lingua condivisa tra il filtro, la tabella e il
// form: tre elenchi separati divergono alla prima aggiunta di un tipo.

export const TX_TYPES = [
  "BUY",
  "SELL",
  "DIVIDEND",
  "COUPON",
  "INTEREST",
  "FEE",
  "TAX",
  "SPLIT",
  "DEPOSIT",
  "WITHDRAWAL",
  "RETURN_OF_CAPITAL",
];

export const TX_TYPE_LABELS = {
  BUY: "Acquisto",
  SELL: "Vendita",
  DIVIDEND: "Dividendo",
  COUPON: "Cedola",
  INTEREST: "Interessi",
  FEE: "Commissione",
  TAX: "Imposta",
  SPLIT: "Split",
  DEPOSIT: "Versamento",
  WITHDRAWAL: "Prelievo",
  RETURN_OF_CAPITAL: "Rimborso di capitale",
};

/** Tono del badge: entrate, uscite, neutro. Non è il segno del netto, è la natura. */
export const TX_TYPE_TONE = {
  BUY: "buy",
  SELL: "sell",
  DIVIDEND: "income",
  COUPON: "income",
  INTEREST: "income",
  FEE: "cost",
  TAX: "cost",
  SPLIT: "neutral",
  DEPOSIT: "cash",
  WITHDRAWAL: "cash",
  RETURN_OF_CAPITAL: "income",
};

const GROUPS = {
  trades: { label: "Compravendite", types: ["BUY", "SELL"] },
  income: { label: "Redditi", types: ["DIVIDEND", "COUPON", "INTEREST", "RETURN_OF_CAPITAL"] },
  costs: { label: "Costi", types: ["FEE", "TAX"] },
  cash: { label: "Cassa", types: ["DEPOSIT", "WITHDRAWAL"] },
};

/** Etichetta di un tipo di movimento, con il codice grezzo come rete di sicurezza. */
export function txTypeLabel(type) {
  return TX_TYPE_LABELS[type] || type;
}

export function TypeBadge({ type }: TypeBadgeProps) {
  return (
    <span className={`badge badge--tx badge--tx-${TX_TYPE_TONE[type] || "neutral"}`}>
      {txTypeLabel(type)}
    </span>
  );
}

/**
 * Barra dei filtri dei movimenti.
 *
 * `value` = { types: string[], instrumentId: string, from, to, q }. Il valore
 * resta stringa anche per instrumentId: è un BIGINT serializzato in stringa e
 * riattraversa la query string invariato.
 */
export default function FilterBar({ value, onChange, instruments = [], instrumentsError = null }: FilterBarProps) {
  const set = (patch) => onChange({ ...value, ...patch });

  const typeSelectValue = (() => {
    if (!value.types || value.types.length === 0) return "";
    if (value.types.length === 1) return value.types[0];
    const group = Object.entries(GROUPS).find(
      ([, g]) =>
        g.types.length === value.types.length && g.types.every((t) => value.types.includes(t))
    );
    return group ? `group:${group[0]}` : "";
  })();

  const onTypeChange = (raw) => {
    if (!raw) return set({ types: [] });
    if (raw.startsWith("group:")) return set({ types: GROUPS[raw.slice(6)].types });
    return set({ types: [raw] });
  };

  const active =
    (value.types?.length ?? 0) > 0 || value.instrumentId || value.from || value.to || value.q;

  return (
    <div className="filterbar card">
      <div className="filterbar-row">
        <label className="field field--inline">
          <span className="field-label">Tipo</span>
          <select className="select" value={typeSelectValue} onChange={(e) => onTypeChange(e.target.value)}>
            <option value="">Tutti i tipi</option>
            {Object.entries(GROUPS).map(([id, g]) => (
              <option key={id} value={`group:${id}`}>
                {g.label}
              </option>
            ))}
            <optgroup label="Singolo tipo">
              {TX_TYPES.map((t) => (
                <option key={t} value={t}>
                  {txTypeLabel(t)}
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        <label className="field field--inline">
          <span className="field-label">Strumento</span>
          <select
            className="select"
            value={value.instrumentId ?? ""}
            onChange={(e) => set({ instrumentId: e.target.value || null })}
          >
            <option value="">Tutti gli strumenti</option>
            {instruments.map((i) => (
              <option key={i.id} value={String(i.id)}>
                {i.ticker ? `${i.ticker} — ${i.name}` : i.name}
              </option>
            ))}
          </select>
          {instrumentsError ? (
            <span className="field-hint">elenco strumenti non disponibile</span>
          ) : null}
        </label>

        <label className="field field--inline field--grow">
          <span className="field-label">Ricerca</span>
          <input
            className="input"
            type="search"
            placeholder="strumento, ISIN o nota"
            value={value.q ?? ""}
            onChange={(e) => set({ q: e.target.value })}
          />
          {/* La ricerca è locale: GET /api/transactions non ha un parametro di
              testo libero, quindi filtra le righe già caricate invece di
              promettere un risultato sull'intero storico. */}
          <span className="field-hint">filtra i movimenti già caricati</span>
        </label>
      </div>

      <div className="filterbar-row">
        <RangePicker
          from={value.from}
          to={value.to}
          onChange={({ from, to }) => set({ from, to })}
          legend="Periodo"
        />
        <button
          type="button"
          className="btn btn--ghost btn--small filterbar-reset"
          onClick={() => onChange({ types: [], instrumentId: null, from: null, to: null, q: "" })}
          disabled={!active}
        >
          Azzera filtri
        </button>
      </div>
    </div>
  );
}
