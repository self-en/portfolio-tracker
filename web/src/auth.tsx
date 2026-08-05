import { createContext, useCallback, useContext, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useLocation } from "react-router-dom";
import { get, post } from "./api";
import { ApiError } from "./api";
import Spinner from "./components/Spinner";
import EmptyState from "./components/EmptyState";
import type { ReactNode } from "react";
import type { AuthMe } from "./types";

interface AuthProviderProps {
  children?: ReactNode;
}

interface NotConfiguredProps {
  error: ApiError | null;
}

interface RequireAuthProps {
  children?: ReactNode;
}

interface AuthContextValue {
  isLoading: boolean;
  authenticated: boolean;
  expiresAt: string | null;
  error: ApiError | null;
  /** Locked mode: la config del deployment è incompleta. */
  notConfigured: boolean;
  dbUnavailable: boolean;
  refresh: () => void;
  logout: () => Promise<void>;
}

/** I dettagli che l'errore di locked mode porta con sé. */
interface NotConfiguredDetails {
  reasons?: string[];
  hint?: string;
}


export const AUTH_QUERY_KEY = ["auth", "me"];

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth richiede AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const queryClient = useQueryClient();

  // GET /api/auth/me non è autenticata di proposito: è il modo di scoprire se
  // esiste una sessione senza incassare un 401 e senza far scattare il redirect
  // globale. `retry: false` perché una risposta negativa è un fatto, non un
  // guasto da riprovare.
  //
  // L'errore è tipizzato ApiError perché è l'unica cosa che api.ts lancia: è ciò
  // che rende leggibili `isNotConfigured`/`isDbUnavailable` qui sotto.
  const query = useQuery<AuthMe, ApiError>({
    queryKey: AUTH_QUERY_KEY,
    queryFn: () => get<AuthMe>("/auth/me"),
    retry: false,
  });

  const logout = useCallback(async () => {
    try {
      await post("/auth/logout");
    } finally {
      // Reload duro: azzera in un colpo la cache react-query costruita sulla
      // sessione appena chiusa.
      queryClient.clear();
      window.location.assign("/login");
    }
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isLoading: query.isPending,
      authenticated: query.data?.authenticated === true,
      expiresAt: query.data?.expiresAt ?? null,
      error: query.error ?? null,
      notConfigured: query.error?.isNotConfigured === true,
      dbUnavailable: query.error?.isDbUnavailable === true,
      refresh: () => queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY }),
      logout,
    }),
    [query.isPending, query.data, query.error, queryClient, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Schermata di locked mode: la config del deployment è incompleta. */
export function NotConfigured({ error }: NotConfiguredProps) {
  const details = (error?.details ?? null) as NotConfiguredDetails | null;
  const reasons = details?.reasons;
  return (
    <main className="page page--centered">
      <div className="card">
        <h1>Configurazione richiesta</h1>
        <p>{error?.message}</p>
        {Array.isArray(reasons) && reasons.length > 0 ? (
          <ul className="list">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
        {details?.hint ? <p className="muted">{details.hint}</p> : null}
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Ho aggiornato la configurazione, ricarica
        </button>
      </div>
    </main>
  );
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { isLoading, authenticated, notConfigured, error } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <main className="page page--centered">
        <Spinner label="Verifica della sessione…" />
      </main>
    );
  }

  if (notConfigured) return <NotConfigured error={error} />;

  // L'errore va valutato PRIMA di `!authenticated`: /auth/me risponde 200
  // {authenticated:false} quando la sessione manca, quindi qui un errore
  // significa server irraggiungibile o rotto, e mandare a /login mentirebbe
  // sulla causa (oltre a mostrare un form che non può funzionare).
  if (error) {
    return (
      <main className="page page--centered">
        <EmptyState title="Sessione non verificabile" message={error.message}>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Riprova
          </button>
        </EmptyState>
      </main>
    );
  }

  if (!authenticated) {
    // `state.from` permette al login di riportare l'utente dove stava andando.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return children;
}
