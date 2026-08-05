// Lettura dei sorgenti per i test di CONFINE ARCHITETTURALE (domain/ importa solo
// decimal.js, market/ non tocca domain/, l'SQL sta solo in repo/).
//
// Esiste perché quei tre test si erano SPENTI senza fallire: filtravano
// `.endsWith(".js")` e cercavano `require("...")`, e dopo il passaggio del backend
// a TypeScript non trovavano più nessun file — passavano iterando su un insieme
// vuoto. Un test che non guarda niente è peggio di un test che non c'è, perché
// sembra verde.
//
// Per questo `readSources` PRETENDE di aver trovato qualcosa: se un giorno
// l'estensione cambia di nuovo, il test fallisce invece di andare in vacanza.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export interface Source {
  /** Nome del file, per i messaggi di errore. */
  file: string;
  /** Percorso relativo alla radice passata (usato dallo scan ricorsivo). */
  rel: string;
  /** Sorgente SENZA commenti. */
  src: string;
}

/**
 * Via i commenti prima di analizzare: questi file PARLANO delle regole che
 * rispettano ("il dominio non chiama mai Date.now()"), e cercare nel testo grezzo
 * darebbe un falso positivo su ogni commento ben scritto.
 */
export function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** I sorgenti TypeScript di una directory. Non ricorsivo. */
export function readSources(dir: string): Source[] {
  const out = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((file) => ({
      file,
      rel: file,
      src: stripComments(fs.readFileSync(path.join(dir, file), "utf8")),
    }));
  assert.ok(out.length > 0, `nessun sorgente .ts in ${dir}: il test di confine non guarderebbe niente`);
  return out;
}

/** Come readSources ma ricorsivo, con `rel` relativo a `root`. */
export function readSourcesDeep(root: string): Source[] {
  const out: Source[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      out.push({
        file: entry.name,
        rel: path.relative(root, full),
        src: stripComments(fs.readFileSync(full, "utf8")),
      });
    }
  };
  walk(root);
  assert.ok(out.length > 0, `nessun sorgente .ts sotto ${root}: il test di confine non guarderebbe niente`);
  return out;
}

export interface ImportRef {
  spec: string;
  /**
   * `import type ...`: CANCELLATO alla compilazione, quindi non crea nessuna
   * dipendenza a runtime. La distinzione conta: un confine architetturale sul
   * *runtime* non può essere violato da un tipo che non esiste più nel JS
   * emesso (verificato: build/domain/bonds.js non richiede src/types).
   */
  typeOnly: boolean;
}

/**
 * Gli specificatori dei moduli importati da un sorgente.
 *
 * Copre le forme che il codice usa: `import x from "m"` / `import { a } from "m"`
 * / `import type { A } from "m"`, `import "m"` per il solo effetto collaterale, e
 * `require("m")` — che nel backend non c'è più ma è ancora la forma in cui un
 * import può rientrare di nascosto.
 */
export function importsOf(src: string): ImportRef[] {
  const out: ImportRef[] = [];

  // `import ... from "m"` e `import type ... from "m"`, su una o più righe.
  for (const m of src.matchAll(/\bimport\s+(type\s+)?([\s\S]*?)\bfrom\s*["']([^"']+)["']/g)) {
    out.push({ spec: m[3], typeOnly: Boolean(m[1]) });
  }
  // `import "m"` — solo effetto collaterale, quindi mai type-only.
  for (const m of src.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
    out.push({ spec: m[1], typeOnly: false });
  }
  for (const m of src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push({ spec: m[1], typeOnly: false });
  }

  return out;
}

/** Solo gli import che sopravvivono alla compilazione. */
export function runtimeImportsOf(src: string): string[] {
  return importsOf(src)
    .filter((i) => !i.typeOnly)
    .map((i) => i.spec);
}
