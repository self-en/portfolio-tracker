import { useEffect } from "react";
import { Outlet, createBrowserRouter } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import { RequireAuth, useAuth } from "./auth";
import { RANGES, useApp } from "./AppContext";
import ErrorBoundary from "./components/ErrorBoundary";
import EmptyState from "./components/EmptyState";
import NavMenu, { NavLinks } from "./components/NavMenu";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Movements from "./pages/Movements";
import Calendar from "./pages/Calendar";
import Instruments from "./pages/Instruments";
import InstrumentDetail from "./pages/InstrumentDetail";
import Portfolios from "./pages/Portfolios";
import type { PortfoliosResponse } from "./types";

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/movimenti", label: "Movimenti" },
  { to: "/calendario", label: "Calendario" },
  { to: "/strumenti", label: "Strumenti" },
  { to: "/portafogli", label: "Portafogli" },
];

function PortfolioSelect() {
  const { portfolioId, setPortfolioId } = useApp();
  const { data, isPending, error } = useQuery({
    queryKey: ["portfolios"],
    queryFn: () => get<PortfoliosResponse>("/portfolios"),
  });

  const items = data?.items ?? [];

  // Un id memorizzato in localStorage può puntare a un portafoglio che non
  // esiste più (database di branch ricreato): in quel caso si ricade sul primo
  // disponibile invece di interrogare l'API con un id morto.
  useEffect(() => {
    if (items.length === 0) return;
    if (!items.some((p) => String(p.id) === portfolioId)) setPortfolioId(items[0].id);
  }, [items, portfolioId, setPortfolioId]);

  if (isPending) return <span className="muted small">portafogli…</span>;
  if (error) return <span className="muted small">portafogli non disponibili</span>;
  if (items.length === 0) return <span className="muted small">nessun portafoglio</span>;

  return (
    <label className="select-wrap">
      <span className="sr-only">Portafoglio</span>
      <select
        className="select"
        value={portfolioId ?? ""}
        onChange={(e) => setPortfolioId(e.target.value)}
      >
        {items.map((p) => (
          <option key={p.id} value={String(p.id)}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function RangeSelect() {
  const { range, setRange } = useApp();
  return (
    <label className="select-wrap">
      <span className="sr-only">Periodo</span>
      <select className="select" value={range} onChange={(e) => setRange(e.target.value)}>
        {RANGES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </label>
  );
}

function Header() {
  const { logout } = useAuth();
  return (
    <header className="topbar">
      <div className="topbar-inner">
        {/* Sotto i 640px la topbar sta su UNA riga: [☰] · portafoglio · periodo.
            Il panino porta le voci e l'Esci, il marchio si nasconde (ogni
            schermata ha già il suo h1) e la larghezza che libera è esattamente
            quella che serve ai due select. */}
        <NavMenu items={NAV} onLogout={logout} />
        <span className="brand">Portfolio Tracker</span>
        <nav className="nav" aria-label="Navigazione principale">
          <NavLinks items={NAV} />
        </nav>
        <div className="topbar-tools">
          <PortfolioSelect />
          <RangeSelect />
          {/* Su telefono l'Esci vive nel pannello del menu: qui resterebbe senza
              spazio, e il cluster dei select sfonderebbe i 360px. */}
          <button
            type="button"
            className="btn btn--ghost btn--small topbar-logout"
            onClick={logout}
          >
            Esci
          </button>
        </div>
      </div>
    </header>
  );
}

function Layout() {
  return (
    <RequireAuth>
      <div className="app">
        <Header />
        <main className="page">
          {/* L'ErrorBoundary sta dentro il layout: un errore di rendering di una
              pagina lascia in piedi la navigazione, così si può andare altrove
              senza ricaricare. */}
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </RequireAuth>
  );
}

function NotFound() {
  return (
    <>
      <h1>Pagina non trovata</h1>
      <EmptyState message="L'indirizzo richiesto non corrisponde a nessuna pagina." />
    </>
  );
}

export const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Dashboard /> },
      { path: "/movimenti", element: <Movements /> },
      { path: "/calendario", element: <Calendar /> },
      { path: "/strumenti", element: <Instruments /> },
      { path: "/strumenti/:id", element: <InstrumentDetail /> },
      { path: "/portafogli", element: <Portfolios /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
