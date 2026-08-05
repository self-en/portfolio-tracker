import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

interface AppProviderProps {
  children?: ReactNode;
}


// Stato di navigazione, non dati: il portafoglio scelto e la finestra temporale.
// I dati del server vivono nella cache di react-query, quindi qui non serve nulla
// più di un contesto — niente Redux, niente Zustand.

const KEY_PORTFOLIO = "pt.portfolioId";
const KEY_RANGE = "pt.range";

export const RANGES = ["1M", "3M", "6M", "YTD", "1A", "MAX"] as const;
export type Range = (typeof RANGES)[number];
const DEFAULT_RANGE: Range = "1A";

const isRange = (v: string | null): v is Range => RANGES.includes(v as Range);

// localStorage può lanciare (Safari in navigazione privata, storage disabilitato):
// una preferenza di UI non deve poter impedire il boot della SPA.
function read(key: string, fallback: string | null = null): string | null {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string | null | undefined): void {
  try {
    if (value === null || value === undefined || value === "") window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(value));
  } catch {
    /* preferenza non persistita: accettabile */
  }
}

interface AppContextValue {
  /**
   * L'id resta una STRINGA: arriva come BIGINT serializzato in stringa e
   * riattraversa l'URL delle query invariato.
   */
  portfolioId: string | null;
  setPortfolioId: (id: string | number | null | undefined) => void;
  range: Range;
  setRange: (next: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp richiede AppProvider");
  return ctx;
}

export function AppProvider({ children }: AppProviderProps) {
  const [portfolioId, setPortfolioIdState] = useState<string | null>(() => read(KEY_PORTFOLIO));
  const [range, setRangeState] = useState<Range>(() => {
    const stored = read(KEY_RANGE, DEFAULT_RANGE);
    return isRange(stored) ? stored : DEFAULT_RANGE;
  });

  useEffect(() => write(KEY_PORTFOLIO, portfolioId), [portfolioId]);
  useEffect(() => write(KEY_RANGE, range), [range]);

  const setPortfolioId = useCallback((id: string | number | null | undefined) => {
    setPortfolioIdState(id === null || id === undefined ? null : String(id));
  }, []);

  const setRange = useCallback((next: string) => {
    setRangeState((prev) => (isRange(next) ? next : prev));
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({ portfolioId, setPortfolioId, range, setRange }),
    [portfolioId, setPortfolioId, range, setRange]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
