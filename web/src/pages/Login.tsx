import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../api";
import { ApiError } from "../api";
import { AUTH_QUERY_KEY, NotConfigured, useAuth } from "../auth";
import Spinner from "../components/Spinner";
import type { FormEvent } from "react";

export default function Login() {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [retryIn, setRetryIn] = useState(0);

  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { authenticated, notConfigured, error: authError, isLoading } = useAuth();

  const from = location.state?.from || "/";

  // Il rate limiter risponde 429 con Retry-After: mostriamo il conto alla
  // rovescia invece di lasciare l'utente a premere un bottone che rifiuterà.
  useEffect(() => {
    if (retryIn <= 0) return undefined;
    const t = window.setTimeout(() => setRetryIn(retryIn - 1), 1000);
    return () => window.clearTimeout(t);
  }, [retryIn]);

  if (isLoading) {
    return (
      <main className="page page--centered">
        <Spinner label="Verifica della sessione…" />
      </main>
    );
  }

  if (notConfigured) return <NotConfigured error={authError} />;
  if (authenticated) return <Navigate to={from} replace />;

  const blocked = pending || retryIn > 0;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    setMessage(null);
    setPending(true);
    try {
      await post("/auth/login", { password });
      // Non ci fidiamo del 204: rileggiamo /auth/me, che è la stessa query da cui
      // dipendono le route protette. Se il cookie non fosse stato accettato (per
      // esempio COOKIE_SECURE=true su http://) qui lo scopriamo subito, invece di
      // rimbalzare tra / e /login.
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
      navigate(from, { replace: true });
    } catch (err) {
      // Lo status e il Retry-After li porta ApiError: qualunque altra cosa
      // arrivi qui vale solo per il suo messaggio.
      if (err instanceof ApiError && err.status === 429) {
        setRetryIn(err.retryAfterSec ?? 60);
        setMessage("Troppi tentativi di accesso.");
      } else if (err instanceof ApiError && err.status === 401) {
        setMessage("Password non corretta.");
      } else {
        setMessage(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="page page--centered">
      <form className="card login" onSubmit={onSubmit}>
        <h1>Portfolio Tracker</h1>
        <p className="muted">Accedi con la password dell'applicazione.</p>

        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="input"
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={blocked}
          />
        </label>

        {message ? (
          <p className="form-error" role="alert">
            {message}
            {retryIn > 0 ? ` Riprova tra ${retryIn} s.` : ""}
          </p>
        ) : null}

        <button type="submit" className="btn btn--primary" disabled={blocked || password === ""}>
          {pending ? <Spinner label="Accesso in corso…" inline /> : "Accedi"}
        </button>
      </form>
    </main>
  );
}
