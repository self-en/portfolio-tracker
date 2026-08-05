import { DASH, date, money, monthLabel, num, qty } from "../format";
import type { CalendarEvent } from "../types";

interface AgendaListProps {
  events: CalendarEvent[];
  monthlyTotals?: any;
  baseCcy?: string;
  onConfirm?: (...args: any[]) => void;
}


// AGENDA MENSILE — una lista, non una heatmap.
//
// Il calendario contiene una dozzina di eventi sparsi su dodici mesi: una griglia
// colorata giorno-per-giorno sarebbe quasi tutta vuota, chiederebbe di leggere una
// data da una posizione in una griglia e non potrebbe mostrare né lo strumento né
// l'importo. La domanda "è davvero un grafico?" manda questo caso su una
// lista/tabella, e il confronto tra mesi lo fa il grafico a colonne accanto.

const KIND_LABELS = {
  COUPON: "Cedola",
  DIVIDEND: "Dividendo",
  REDEMPTION: "Rimborso",
  SPLIT: "Split",
  INTEREST: "Interessi",
};

// La convenzione dell'importo per unità va DICHIARATA, non indovinata: per le
// cedole è per 100 di NOMINALE, per i dividendi è per azione. Confonderle sbaglia
// di un fattore 10 (docs/decisions.md §9).
const UNIT_LABELS = {
  per_100_nominale: "per 100 di nominale",
  per_azione: "per azione",
};

// `confidence` si rende con PIENO vs TRATTEGGIATO più un'etichetta testuale: il
// canale visivo da solo non basta, e la parola dice qual è la fonte del dato.
const CONFIDENCE = {
  paid: { label: "incassato", fill: "solid" },
  announced: { label: "annunciato dall'emittente", fill: "solid" },
  scheduled: { label: "da scadenzario cedolare", fill: "dashed" },
  estimated: { label: "stimato", fill: "dashed" },
};

function Confidence({ confidence }) {
  const c = CONFIDENCE[confidence] || { label: confidence, fill: "dashed" };
  return (
    <span className="pt-conf pt-agenda-conf">
      <span className={`pt-conf-mark pt-conf-mark--${c.fill}`} aria-hidden="true" />
      {c.label}
    </span>
  );
}

function groupByMonth(events) {
  const groups = new Map();
  for (const ev of events) {
    const key = String(ev.payDate).slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, items]) => ({
      key,
      items: [...items].sort((a, b) => (a.payDate < b.payDate ? -1 : 1)),
    }));
}

/**
 * @param {object} props
 * @param {Array} props.events eventi di GET /api/calendar
 * @param {Array} [props.monthlyTotals] totali mensili della stessa risposta
 * @param {string} props.baseCcy
 * @param {(event: object) => void} [props.onConfirm]
 */
export default function AgendaList({ events, monthlyTotals, baseCcy = "EUR", onConfirm }: AgendaListProps) {
  const groups = groupByMonth(events || []);
  const totals = new Map((monthlyTotals || []).map((t) => [t.month, t]));

  return (
    <div className="pt-agenda">
      {groups.map((group) => {
        const total = totals.get(group.key);
        return (
          <section className="pt-agenda-month" key={group.key} id={`mese-${group.key}`}>
            <div className="pt-agenda-monthhead">
              <h3 className="pt-agenda-monthname">{monthLabel(group.key)}</h3>
              <span className="pt-agenda-monthtotal">
                {num(group.items.length, 0)} {group.items.length === 1 ? "evento" : "eventi"}
                {total ? ` · lordo ${money(total.gross, baseCcy)}` : null}
                {total && total.projected && total.projected !== "0.00"
                  ? ` (di cui proiettato ${money(total.projected, baseCcy)})`
                  : null}
              </span>
            </div>

            <ul className="pt-agenda-list">
              {group.items.map((ev) => (
                <li className="pt-agenda-item" key={ev.id}>
                  <span className="pt-agenda-date">{date(ev.payDate)}</span>

                  <span className="pt-agenda-main">
                    <span className="pt-agenda-name">
                      {KIND_LABELS[ev.kind] || ev.kind} · {ev.instrument?.name || DASH}
                    </span>
                    <span className="pt-agenda-meta">
                      {[ev.instrument?.ticker, ev.instrument?.isin].filter(Boolean).join(" · ")}
                      {ev.exDate ? ` · stacco ${date(ev.exDate)}` : null}
                      {ev.quantityAtDate ? ` · ${qty(ev.quantityAtDate)} in portafoglio` : null}
                    </span>
                  </span>

                  <Confidence confidence={ev.confidence} />

                  <span className="pt-agenda-amounts">
                    <span className="pt-agenda-gross">
                      {money(ev.estimatedGrossBase, baseCcy)}
                    </span>
                    <span className="pt-agenda-unit">
                      {ev.amountPerUnit === null || ev.amountPerUnit === undefined
                        ? "importo non dichiarato"
                        : `${num(ev.amountPerUnit, 4)} ${ev.currency} ${
                            UNIT_LABELS[ev.amountUnit] || ev.amountUnit
                          }`}
                    </span>
                  </span>

                  <span className="pt-agenda-actions">
                    {ev.transactionId ? (
                      <span className="badge">registrato</span>
                    ) : onConfirm ? (
                      <button
                        type="button"
                        className="btn btn--small btn--primary"
                        onClick={() => onConfirm(ev)}
                      >
                        Conferma incasso
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
