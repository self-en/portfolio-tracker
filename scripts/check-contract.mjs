#!/usr/bin/env node
// Verifica il contratto di configurazione con la piattaforma self-en.
// Gira nella CI (prima della build dell'immagine) e in locale con
// `npm run check:contract`. Nessuna dipendenza: solo Node.
//
// Serve a rendere MECCANICA una regola che altrimenti resterebbe solo scritta in
// CLAUDE.md: se una variabile d'ambiente viene letta senza essere dichiarata, la
// piattaforma non puo' chiederla all'utente e l'app va in errore a runtime senza
// che nessuno sappia cosa impostare. Qui invece la build diventa rossa - quindi
// nessuna immagine pubblicata, quindi il problema si vede subito.
//
// Controlla che:
//   1. self-en.json esista e sia valido (chiavi in UPPER_SNAKE, nessun duplicato,
//      nessuna variabile riservata alla piattaforma);
//   2. src/platform/config.ts (file della piattaforma) sia presente e marcato con
//      la sua versione di contratto;
//   3. src/server.ts registri il modulo (registerPlatformConfig);
//   4. le letture di process.env stiano in UN SOLO modulo e riguardino variabili
//      dichiarate (o iniettate dalla piattaforma, allowlist qui sotto).
//
// Sul punto 4: il modulo puo' essere quello della piattaforma (il default) oppure
// quello dell'app, dichiarandolo in self-en.json come "configModule". Un'app che
// centralizza la configurazione in un proprio src/config.ts rispetta la regola -
// quello che la regola vuole impedire e' un process.env sparso in venti file, non
// il fatto che il file si chiami in un certo modo.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// Variabili iniettate dalla piattaforma o dal runtime: leggibili direttamente,
// non si dichiarano (e non si possono sovrascrivere dalla Configurazione).
const PLATFORM_VARS = new Set([
  "PORT",
  "LOG_LEVEL",
  "NODE_ENV",
  "NODE_OPTIONS",
  "REPO_NAME",
  "BRANCH_NAME",
  "DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
]);
const PLATFORM_PREFIXES = ["OTEL_"];

const isPlatformVar = (key) => PLATFORM_VARS.has(key) || PLATFORM_PREFIXES.some((p) => key.startsWith(p));

const errors = [];
const fail = (message) => errors.push(message);

// --- 1. self-en.json ---------------------------------------------------------
const declarationPath = path.join(root, "self-en.json");
let declared = [];
let configModules = [];
if (!existsSync(declarationPath)) {
  fail("Manca self-en.json nella radice del progetto: e' il file in cui si dichiarano le variabili d'ambiente.");
} else {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(declarationPath, "utf8"));
  } catch (err) {
    fail(`self-en.json non e' un JSON valido: ${err.message}`);
  }
  if (parsed) {
    if (parsed.configModule !== undefined) {
      const list = Array.isArray(parsed.configModule) ? parsed.configModule : [parsed.configModule];
      if (list.some((m) => typeof m !== "string")) {
        fail('self-en.json: "configModule" deve essere un percorso (o un elenco di percorsi).');
      } else {
        configModules = list;
      }
    }
    if (!Array.isArray(parsed.env)) {
      fail('self-en.json deve contenere un array "env" (anche vuoto: {"contract": 1, "env": []}).');
    } else {
      const seen = new Set();
      for (const [index, entry] of parsed.env.entries()) {
        const where = `self-en.json → env[${index}]`;
        if (!entry || typeof entry !== "object") {
          fail(`${where}: deve essere un oggetto.`);
          continue;
        }
        if (typeof entry.key !== "string" || !KEY_RE.test(entry.key)) {
          fail(`${where}: "key" mancante o non valida (usa UPPER_SNAKE_CASE, max 64 caratteri).`);
          continue;
        }
        if (seen.has(entry.key)) fail(`${where}: la variabile ${entry.key} e' dichiarata piu' di una volta.`);
        seen.add(entry.key);
        if (isPlatformVar(entry.key)) {
          fail(`${where}: ${entry.key} e' gestita dalla piattaforma, non va dichiarata (non e' configurabile).`);
        }
        if (entry.required !== false && !entry.label) {
          fail(`${where}: ${entry.key} e' obbligatoria, quindi serve una "label" leggibile da mostrare nel form.`);
        }
        if (entry.generate && entry.generate !== "secret32" && entry.generate !== "password") {
          fail(`${where}: "generate" puo' valere solo "secret32" o "password".`);
        }
        if (entry.scope && entry.scope !== "all" && entry.scope !== "main") {
          fail(`${where}: "scope" puo' valere solo "all" o "main".`);
        }
        declared.push(entry.key);
      }
    }
  }
}

// --- 2. modulo della piattaforma --------------------------------------------
const modulePath = path.join(root, "src", "platform", "config.ts");
if (!existsSync(modulePath)) {
  fail(
    "Manca src/platform/config.ts (modulo gestito dalla piattaforma). Non va cancellato: puoi ripristinarlo dalla pagina Configurazione del progetto in nedo."
  );
} else {
  const text = readFileSync(modulePath, "utf8");
  if (!/self-en-contract:\s*\d+/.test(text)) {
    fail("src/platform/config.ts ha perso il marcatore 'self-en-contract: <n>': e' stato modificato a mano?");
  }
}

// --- 3. registrazione in server.ts ------------------------------------------
const serverPath = path.join(root, "src", "server.ts");
if (!existsSync(serverPath)) {
  fail("Manca src/server.ts.");
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === "node_modules" || entry === "build" || entry === "dist" || entry.startsWith(".")) continue;
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const allFiles = [...walk(path.join(root, "src")), ...walk(path.join(root, "web"))];

// --- 3b. la registrazione del modulo, in un punto qualsiasi di src/ ----------
// Non solo in server.ts: in un'app un po' cresciuta l'istanza Fastify si
// costruisce in una factory (src/app.ts), ed e' li' che la registrazione va.
if (!allFiles.some((f) => readFileSync(f, "utf8").includes("registerPlatformConfig("))) {
  fail(
    "Nessun file chiama registerPlatformConfig(app): senza quella riga la piattaforma non puo' sapere quali variabili servono all'app."
  );
}

// --- 4. process.env fuori dai moduli di configurazione -----------------------
// Esentati: il modulo della piattaforma e gli eventuali "configModule" dichiarati
// in self-en.json (vedi la nota in testa al file).
const exempt = [path.join("src", "platform") + path.sep, ...configModules.map((m) => path.normalize(m))];
const isExempt = (rel) => exempt.some((e) => rel === e || rel.startsWith(e));
const files = allFiles.filter((f) => !isExempt(path.relative(root, f)));

for (const file of files) {
  const relative = path.relative(root, file);
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (/process\.env\s*\[/.test(line)) {
      fail(
        `${relative}:${index + 1}: accesso dinamico a process.env[...]: usa config.get("NOME") con la variabile dichiarata in self-en.json.`
      );
    }
    for (const match of line.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const key = match[1];
      if (isPlatformVar(key)) continue;
      const hint = declared.includes(key)
        ? `e' dichiarata in self-en.json: leggila con config.get("${key}")`
        : `non e' dichiarata: aggiungila a self-en.json e leggila con config.get("${key}")`;
      fail(`${relative}:${index + 1}: process.env.${key} ${hint}.`);
    }
  }
}

if (errors.length) {
  console.error(`\n✗ Contratto self-en non rispettato (${errors.length}):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error("");
  process.exit(1);
}

console.log(
  `✓ Contratto self-en ok (${declared.length} variabil${declared.length === 1 ? "e" : "i"} dichiarat${
    declared.length === 1 ? "a" : "e"
  }).`
);
