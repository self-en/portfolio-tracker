// Unica uscita HTTP della SPA.
//
// Il server ha una forma d'errore sola — { error: { code, message, details? } } —
// e la traduzione in ApiError avviene solo qui: nessuna pagina deve ragionare in
// termini di status code.

export const API_BASE = "/api";

export class ApiError extends Error {
  constructor({ code, message, details, status, retryAfterSec }) {
    super(message || "Errore inatteso.");
    this.name = "ApiError";
    this.code = code || "unknown";
    this.details = details;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }

  // Locked mode: la config del deployment è incompleta. Non è un errore
  // transitorio da riprovare, è una schermata di configurazione.
  get isNotConfigured() {
    return this.status === 503 && this.code === "not_configured";
  }

  get isDbUnavailable() {
    return this.status === 503 && this.code === "db_unavailable";
  }

  get isUnauthorized() {
    return this.status === 401;
  }
}

// Messaggi che sostituiscono quelli del server perché devono dire all'utente
// cosa FARE, non solo cosa è andato storto.
const CLIENT_MESSAGES = {
  not_configured:
    "L'applicazione non è configurata: imposta APP_PASSWORD e SESSION_SECRET (almeno 32 caratteri) nell'ambiente del deployment.",
  db_unavailable:
    "Database non raggiungibile: i dati non sono disponibili in questo momento. Le migrazioni potrebbero essere ancora in corso.",
  network_error: "Server non raggiungibile. Controlla la connessione e riprova.",
};

function toQuery(params) {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) for (const v of value) sp.append(key, String(v));
    else sp.append(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

// I path sono relativi a /api ("/auth/me"); /healthz e gli URL assoluti passano
// così come sono.
function resolveUrl(path) {
  if (/^https?:\/\//.test(path) || path.startsWith("/healthz")) return path;
  return API_BASE + path;
}

async function readBody(res) {
  if (res.status === 204 || res.headers.get("Content-Length") === "0") return null;
  const type = res.headers.get("Content-Type") || "";
  if (!type.includes("json")) {
    const text = await res.text().catch(() => "");
    return text || null;
  }
  return res.json().catch(() => null);
}

function readRetryAfter(res, details) {
  const header = res.headers.get("Retry-After");
  if (header && /^\d+$/.test(header)) return Number(header);
  if (typeof details?.retryAfterSec === "number") return details.retryAfterSec;
  return undefined;
}

function redirectToLogin() {
  // Redirect duro invece del router: un 401 può arrivare da qualsiasi punto,
  // anche fuori da un componente, e una navigazione lato client conserverebbe una
  // cache react-query costruita su una sessione che non esiste più.
  if (window.location.pathname !== "/login") window.location.assign("/login");
}

async function request(method, path, { body, query, signal, headers } = {}) {
  const init = {
    method,
    // Il cookie di sessione è httpOnly e same-origin: senza questo non viaggia.
    credentials: "same-origin",
    signal,
    headers: { Accept: "application/json", ...headers },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(resolveUrl(path) + toQuery(query), init);
  } catch (cause) {
    // Un abort è react-query che cambia idea, non un guasto: va propagato tale
    // e quale, altrimenti finisce in UI come "server non raggiungibile".
    if (cause?.name === "AbortError") throw cause;
    throw new ApiError({
      code: "network_error",
      message: CLIENT_MESSAGES.network_error,
      status: 0,
    });
  }

  const payload = await readBody(res);
  if (res.ok) return payload;

  const shape = (payload && payload.error) || {};
  const code = shape.code || `http_${res.status}`;
  const error = new ApiError({
    code,
    message: CLIENT_MESSAGES[code] || shape.message,
    details: shape.details,
    status: res.status,
    retryAfterSec: readRetryAfter(res, shape.details),
  });

  // /auth/me è la sonda con cui la SPA scopre di NON avere una sessione: se
  // redirigesse anche lei, /login entrerebbe in un ciclo di reload.
  if (res.status === 401 && path !== "/auth/me") redirectToLogin();

  throw error;
}

export const get = (path, opts) => request("GET", path, opts);
export const post = (path, body, opts) => request("POST", path, { ...opts, body });
export const patch = (path, body, opts) => request("PATCH", path, { ...opts, body });
export const put = (path, body, opts) => request("PUT", path, { ...opts, body });
export const del = (path, opts) => request("DELETE", path, opts);
