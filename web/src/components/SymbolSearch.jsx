import { useEffect, useRef, useState } from "react";
import { get } from "../api.js";
import Spinner from "./Spinner.jsx";

const DEBOUNCE_MS = 350;
const MIN_CHARS = 2; // il server rifiuta con 422 sotto i 2 caratteri

/**
 * Ricerca simbolo sul provider di mercato.
 *
 * È BEST-EFFORT, non un requisito: se l'upstream non risponde il componente lo
 * dice e invita a inserire ticker e ISIN a mano. Un form che si blocca perché
 * Yahoo è giù sarebbe inutilizzabile proprio per gli strumenti che Yahoo non
 * copre — le obbligazioni, dove la ricerca restituisce comunque zero risultati
 * (docs/decisions.md §9).
 *
 * Il debounce a 350 ms combacia con quello previsto dal server, che tiene una LRU
 * di 10 minuti proprio per questa chiamata.
 */
export default function SymbolSearch({ onSelect, disabled = false }) {
  const [term, setTerm] = useState("");
  const [items, setItems] = useState([]);
  const [state, setState] = useState("idle"); // idle | loading | ok | unavailable
  const [message, setMessage] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    const q = term.trim();
    if (q.length < MIN_CHARS) {
      setItems([]);
      setState("idle");
      setMessage(null);
      return undefined;
    }

    const timer = window.setTimeout(async () => {
      // Una richiesta ancora in volo viene abortita: senza, l'ultima risposta
      // arrivata (non l'ultima richiesta fatta) vincerebbe la corsa.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState("loading");
      try {
        const data = await get("/market/search", { query: { q }, signal: controller.signal });
        setItems(Array.isArray(data?.items) ? data.items : []);
        setState("ok");
        setMessage(null);
      } catch (err) {
        if (err?.name === "AbortError") return;
        setItems([]);
        setState("unavailable");
        setMessage(
          err?.code === "upstream_error" || err?.code === "network_error"
            ? "Ricerca non disponibile: inserisci ticker e ISIN a mano."
            : err?.message || "Ricerca non disponibile: inserisci ticker e ISIN a mano."
        );
      }
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [term]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div className="symbol-search">
      <label className="field">
        <span className="field-label">Cerca simbolo</span>
        <input
          className="input"
          type="search"
          autoComplete="off"
          placeholder="nome, ticker o ISIN"
          value={term}
          disabled={disabled}
          onChange={(e) => setTerm(e.target.value)}
        />
        <span className="field-hint">
          Facoltativa: compila ticker, nome e borsa al posto tuo. Le obbligazioni non
          sono coperte, inseriscile a mano.
        </span>
      </label>

      {state === "loading" ? <Spinner label="Ricerca…" /> : null}

      {state === "unavailable" ? (
        <p className="search-unavailable" role="status">
          {message}
        </p>
      ) : null}

      {state === "ok" && items.length === 0 ? (
        <p className="muted small">Nessun risultato: inserisci ticker e ISIN a mano.</p>
      ) : null}

      {items.length > 0 ? (
        <ul className="search-results">
          {items.map((it) => (
            <li key={it.symbol}>
              <button
                type="button"
                className="search-result"
                onClick={() => {
                  onSelect?.(it);
                  setTerm("");
                  setItems([]);
                  setState("idle");
                }}
              >
                <span className="search-symbol">{it.symbol}</span>
                <span className="search-name">{it.name}</span>
                <span className="muted small">
                  {[it.exchange, it.quoteType].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
