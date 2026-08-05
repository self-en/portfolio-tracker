// self-en-contract: 1 - file gestito dalla piattaforma self-en, NON MODIFICARE.
// Viene riscritto alla versione canonica dal job "sync-contract" di nedo: ogni
// modifica manuale verra' persa.
//
// Cosa fa: implementa il contratto di configurazione fra l'app e la piattaforma.
//
//   self-en.json  (lo dichiari TU: quali variabili servono all'app)
//        |
//        +--> questo modulo: valida process.env, espone GET /_self-en/config
//             (dichiarazione + variabili mancanti) e, quando manca qualcosa di
//             obbligatorio, risponde con una pagina "non configurata" invece di
//             far finta che tutto vada bene.
//
// La piattaforma legge `self-en.json` da GitHub (per mostrarti subito il form
// nella pagina "Configurazione" del progetto) e questo endpoint dall'ambiente in
// esecuzione (per sapere cosa manca DAVVERO). Non c'e' duplicazione: la
// dichiarazione e' un file di dati, questo modulo la legge.
//
// Due scelte volute, importanti:
//  1. /healthz NON deve fallire per configurazione mancante (e questo modulo non
//     lo tocca): e' la readinessProbe, se fallisce il pod esce dal Service, il
//     Gateway risponde 503 e questa pagina - insieme all'endpoint qui sotto -
//     diventa irraggiungibile proprio quando servirebbe.
//  2. La pagina "non configurata" risponde 200 (e' una risposta valida e utile,
//     rivolta a una persona); solo le chiamate /api/* rispondono 503, cosi' il
//     frontend dell'app vede un errore vero.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

export const CONTRACT_VERSION = 1;

export interface EnvDeclaration {
  key: string;
  label?: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
  // Suggerisce alla UI di nedo un pulsante "genera" per questo valore.
  generate?: "secret32" | "password";
  // Suggerimento sullo scope: "all" (tutte le versioni) o "main" (solo
  // produzione). Lo scope effettivo resta quello salvato in nedo.
  scope?: "all" | "main";
}

const DECLARATION_FILE = "self-en.json";
const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// Cerca self-en.json risalendo da questo file: in locale (tsx) siamo in
// src/platform, nel container in build/platform, in entrambi i casi la radice
// del progetto e' due livelli sopra - ma risalire e' piu' robusto di un
// "../.." hardcodato se un giorno cambia il layout della build.
function findDeclarationFile(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, DECLARATION_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Tollerante per scelta: file assente o malformato => nessuna dichiarazione.
// L'app deve poter partire comunque (e la piattaforma se ne accorge dal fatto
// che l'endpoint risponde con `env: []`).
function loadDeclarations(): { declarations: EnvDeclaration[]; problem: string | null } {
  const file = findDeclarationFile();
  if (!file) return { declarations: [], problem: `${DECLARATION_FILE} non trovato` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { declarations: [], problem: `${DECLARATION_FILE} non valido: ${(err as Error).message}` };
  }
  const raw = (parsed as { env?: unknown } | null)?.env;
  if (!Array.isArray(raw)) return { declarations: [], problem: `${DECLARATION_FILE}: campo "env" mancante o non un array` };
  const declarations: EnvDeclaration[] = [];
  for (const entry of raw) {
    const key = (entry as { key?: unknown } | null)?.key;
    if (typeof key !== "string" || !KEY_RE.test(key)) continue;
    const e = entry as EnvDeclaration;
    declarations.push({
      key,
      label: typeof e.label === "string" ? e.label : undefined,
      description: typeof e.description === "string" ? e.description : undefined,
      required: e.required !== false,
      secret: e.secret !== false,
      generate: e.generate === "secret32" || e.generate === "password" ? e.generate : undefined,
      scope: e.scope === "main" ? "main" : "all",
    });
  }
  return { declarations, problem: null };
}

const { declarations, problem } = loadDeclarations();
const byKey = new Map(declarations.map((d) => [d.key, d]));

export function declaredEnv(): EnvDeclaration[] {
  return declarations;
}

function isSet(key: string): boolean {
  const value = process.env[key];
  return typeof value === "string" && value.trim() !== "";
}

// Le variabili obbligatorie dichiarate che non sono valorizzate nell'ambiente.
export function missingEnv(): string[] {
  return declarations.filter((d) => d.required && !isSet(d.key)).map((d) => d.key);
}

export function isConfigured(): boolean {
  return missingEnv().length === 0;
}

// Unico modo corretto di leggere una variabile di configurazione dall'app:
// throwa se la chiave non e' dichiarata in self-en.json (cosi' una variabile
// "di nascosto" non puo' esistere - la piattaforma non potrebbe chiederla
// all'utente) o se e' obbligatoria e non valorizzata.
export function get(key: string): string {
  const declaration = byKey.get(key);
  if (!declaration) {
    throw new Error(
      `La variabile ${key} non e' dichiarata in ${DECLARATION_FILE}: aggiungila la' (con label e description) invece di leggere process.env direttamente.`
    );
  }
  const value = process.env[key];
  if (typeof value === "string" && value.trim() !== "") return value;
  if (declaration.required) throw new Error(`La variabile obbligatoria ${key} non e' configurata.`);
  return "";
}

// Come get(), ma per le variabili opzionali: null invece di stringa vuota.
export function getOptional(key: string): string | null {
  const value = get(key);
  return value === "" ? null : value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unconfiguredPage(missing: string[]): string {
  const items = missing
    .map((key) => {
      const d = byKey.get(key);
      const label = d?.label ? ` &mdash; ${escapeHtml(d.label)}` : "";
      const description = d?.description ? `<div class="hint">${escapeHtml(d.description)}</div>` : "";
      return `<li><code>${escapeHtml(key)}</code>${label}${description}</li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Applicazione da configurare</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #f6f7f9; color: #1c2024; }
  main { max-width: 40rem; padding: 2.5rem; margin: 1.5rem; background: #fff;
         border-radius: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
  ul { padding-left: 1.2rem; }
  li { margin-bottom: .6rem; }
  code { background: #eef0f3; padding: .1rem .35rem; border-radius: 5px; font-size: .92em; }
  .hint { color: #5b6570; font-size: .9rem; }
  .steps { color: #5b6570; font-size: .95rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181b; color: #e7e9ea; }
    main { background: #1e2125; box-shadow: none; }
    code { background: #2a2e34; }
    .hint, .steps { color: #a3acb6; }
  }
</style>
</head>
<body>
<main>
  <h1>Questa applicazione deve ancora essere configurata</h1>
  <p>Mancano ${missing.length === 1 ? "una variabile" : `${missing.length} variabili`} di configurazione:</p>
  <ul>
${items}
  </ul>
  <p class="steps">
    Impostale dal pannello <strong>nedo</strong>: apri il progetto, vai su
    <strong>Configurazione</strong>, inserisci i valori e salva. La versione
    ripartira' da sola con la nuova configurazione.
  </p>
</main>
</body>
</html>
`;
}

// Da chiamare in src/server.ts subito dopo aver creato l'istanza Fastify:
//   registerPlatformConfig(app);
export function registerPlatformConfig(app: FastifyInstance): void {
  if (problem) app.log.warn(`[self-en] ${problem}`);
  const missingAtBoot = missingEnv();
  if (missingAtBoot.length) {
    app.log.warn(`[self-en] configurazione incompleta, variabili mancanti: ${missingAtBoot.join(", ")}`);
  }

  // Stato leggibile dalla piattaforma. Sempre disponibile, anche (soprattutto)
  // quando la configurazione manca.
  app.get("/_self-en/config", async () => ({
    contract: CONTRACT_VERSION,
    env: declarations,
    missing: missingEnv(),
  }));

  app.addHook("onRequest", async (request, reply) => {
    const missing = missingEnv();
    if (missing.length === 0) return; // configurata: nessuna interferenza
    const url = request.raw.url ?? "";
    if (url.startsWith("/_self-en/") || url.startsWith("/healthz")) return;
    if (url.startsWith("/api/")) {
      return reply.code(503).send({ error: "application not configured", missing });
    }
    return reply.code(200).type("text/html; charset=utf-8").send(unconfiguredPage(missing));
  });
}
