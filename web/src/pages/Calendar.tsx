import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "../api";
import { useApp } from "../AppContext";
import { date } from "../format";
import AgendaList from "../components/AgendaList";
import ConfirmEventDialog from "../components/ConfirmEventDialog";
import EmptyState from "../components/EmptyState";
import MonthGrid from "../components/MonthGrid";
import Spinner from "../components/Spinner";
import WarningsBanner from "../components/WarningsBanner";
import IncomeByMonthChart from "../charts/IncomeByMonthChart";
import "../charts/charts.css";

// Aritmetica sulle date su stringhe "YYYY-MM-DD" con Date.UTC, mai su un Date in
// fuso locale: così il DST si aggira invece di testarci intorno
// (docs/decisions.md §6).
const todayIso = () => new Date().toISOString().slice(0, 10);

function shiftMonths(iso, months) {
  const from = new Date(`${iso}T00:00:00Z`);
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
}

// Una sola riga di filtri, sopra tutto ciò che governa: agenda e grafico si
// ridisegnano sulla stessa fetta, così i numeri concordano sempre.
function windows() {
  const at = todayIso();
  const year = at.slice(0, 4);
  return [
    { id: "default", label: "Da 3 mesi a +12", from: undefined, to: undefined },
    { id: "next12", label: "Prossimi 12 mesi", from: at, to: shiftMonths(at, 12) },
    { id: "year", label: `Anno ${year}`, from: `${year}-01-01`, to: `${year}-12-31` },
    { id: "past12", label: "Ultimi 12 mesi", from: shiftMonths(at, -12), to: at },
  ];
}

export default function Calendar() {
  const { portfolioId } = useApp();
  const ranges = useMemo(windows, []);
  const [windowId, setWindowId] = useState("default");
  const [confirming, setConfirming] = useState(null);

  const active = ranges.find((r) => r.id === windowId) || ranges[0];

  const query = useQuery({
    queryKey: ["calendar", portfolioId, active.from ?? null, active.to ?? null],
    queryFn: () =>
      get("/calendar", {
        query: { portfolioId: portfolioId || undefined, from: active.from, to: active.to },
      }),
  });

  const events = query.data?.events ?? [];
  const monthlyTotals = query.data?.monthlyTotals ?? [];
  const baseCcy = query.data?.baseCcy || "EUR";

  const months = useMemo(() => {
    const counts = new Map();
    for (const ev of events) {
      const key = String(ev.payDate).slice(0, 7);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const grossByMonth = new Map(monthlyTotals.map((t) => [t.month, t.gross]));
    return [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, count]) => ({ key, count, gross: grossByMonth.get(key) ?? null }));
  }, [events, monthlyTotals]);

  return (
    <>
      <div className="pt-section-head">
        <h1>Calendario</h1>
        {query.data ? (
          <span className="muted small">
            finestra dal {date(query.data.from)} al {date(query.data.to)}
          </span>
        ) : null}
      </div>

      <div className="pt-filterbar" role="group" aria-label="Finestra temporale">
        <span className="pt-filterbar-label">Periodo</span>
        {ranges.map((r) => (
          <button
            key={r.id}
            type="button"
            className={r.id === windowId ? "btn btn--small pt-chip--on" : "btn btn--small"}
            aria-pressed={r.id === windowId}
            onClick={() => setWindowId(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <Spinner label="Caricamento del calendario…" />
      ) : query.error ? (
        <EmptyState
          title="Calendario non disponibile"
          message={query.error.message}
          action={
            <button type="button" className="btn" onClick={() => query.refetch()}>
              Riprova
            </button>
          }
        />
      ) : events.length === 0 ? (
        <EmptyState
          title="Nessuna scadenza nella finestra scelta"
          message="Le cedole future si generano dallo scadenzario di un'obbligazione: inserisci valore facciale, tasso, frequenza e scadenza dalla pagina Strumenti."
        />
      ) : (
        <>
          <WarningsBanner warnings={query.data.warnings} />

          <div className="pt-stack">
            <IncomeByMonthChart
              items={monthlyTotals}
              baseCcy={baseCcy}
              refetching={query.isFetching}
            />
          </div>

          <MonthGrid months={months} baseCcy={baseCcy} currentKey={todayIso().slice(0, 7)} />

          <AgendaList
            events={events}
            monthlyTotals={monthlyTotals}
            baseCcy={baseCcy}
            onConfirm={setConfirming}
          />
        </>
      )}

      {confirming ? (
        <ConfirmEventDialog
          event={confirming}
          portfolioId={portfolioId}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </>
  );
}
