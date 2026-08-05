import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface AppProviderProps {
  children?: ReactNode;
}


// Stato di navigazione, non dati: il portafoglio scelto e la finestra temporale.
// I dati del server vivono nella cache di react-query, quindi qui non serve nulla
// più di un contesto — niente Redux, niente Zustand.

const KEY_PORTFOLIO = "pt.portfolioId";
const KEY_RANGE = "pt.range";

export const RANGES = ["1M", "3M", "6M", "YTD", "1A", "MAX"];
const DEFAULT_RANGE = "1A";

// localStorage può lanciare (Safari in navigazione privata, storage disabilitato):
// una preferenza di UI non deve poter impedire il boot della SPA.
function read(key, fallback = null) {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value === null || value === undefined || value === "") window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(value));
  } catch {
    /* preferenza non persistita: accettabile */
  }
}

const AppContext = createContext(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp richiede AppProvider");
  return ctx;
}

export function AppProvider({ children }: AppProviderProps) {
  const [portfolioId, setPortfolioIdState] = useState(() => read(KEY_PORTFOLIO));
  const [range, setRangeState] = useState(() => {
    const stored = read(KEY_RANGE, DEFAULT_RANGE);
    return RANGES.includes(stored) ? stored : DEFAULT_RANGE;
  });

  useEffect(() => write(KEY_PORTFOLIO, portfolioId), [portfolioId]);
  useEffect(() => write(KEY_RANGE, range), [range]);

  // L'id resta una stringa: gli id arrivano come BIGINT serializzato in stringa e
  // riattraversano l'URL delle query invariati.
  const setPortfolioId = useCallback((id) => {
    setPortfolioIdState(id === null || id === undefined ? null : String(id));
  }, []);

  const setRange = useCallback((next) => {
    setRangeState((prev) => (RANGES.includes(next) ? next : prev));
  }, []);

  const value = useMemo(
    () => ({ portfolioId, setPortfolioId, range, setRange }),
    [portfolioId, setPortfolioId, range, setRange]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
