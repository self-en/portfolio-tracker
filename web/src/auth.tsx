import { createContext, useCallback, useContext, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useLocation } from "react-router-dom";
import { get, post } from "./api";
import Spinner from "./components/Spinner";
import EmptyState from "./components/EmptyState";

interface AuthProviderProps {
  children?: ReactNode;
}

interface NotConfiguredProps {
  error: ReactNode;
}

interface RequireAuthProps {
  children?: ReactNode;
}


export const AUTH_QUERY_KEY = ["auth", "me"];

const AuthContext = createContext(null);

export function useAuth() {
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
  const query = useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: () => get("/auth/me"),
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

  const value = useMemo(
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
  const reasons = error?.details?.reasons;
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
        {error?.details?.hint ? <p className="muted">{error.details.hint}</p> : null}
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
