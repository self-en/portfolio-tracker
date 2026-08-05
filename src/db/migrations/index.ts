// Array ORDINATO ESPLICITAMENTE di migrazioni. Nessun globbing di directory:
// l'ordinamento lessicografico di un glob è una classica ferita autoinflitta
// (001, 002, ... 010 va bene finché qualcuno non aggiunge 10_qualcosa.sql).
//
// Aggiungere una migrazione = aggiungere un file E una riga qui. Mai modificare
// una migrazione già applicata: il checksum lo rileva e lo logga.
import fs from "node:fs";
import path from "node:path";

export interface Migration {
  version: string;
  sql: string;
}

const read = (f: string): string => fs.readFileSync(path.join(__dirname, f), "utf8");

const migrations: Migration[] = [
  { version: "001_init", sql: read("001_init.sql") },
  { version: "002_seed", sql: read("002_seed.sql") },
  { version: "003_standalone_fees", sql: read("003_standalone_fees.sql") },
];

// Esportato in entrambe le forme: `default` per gli import TypeScript, nominato
// perche' e' cosi' che lo legge chi fa require() (i test) senza passare da
// `.default` - un dettaglio di interoperabilita' CJS/ESM che non vale la pena
// far pagare al chiamante.
export { migrations };
export default migrations;
