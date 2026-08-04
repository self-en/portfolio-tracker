// Array ORDINATO ESPLICITAMENTE di migrazioni. Nessun globbing di directory:
// l'ordinamento lessicografico di un glob è una classica ferita autoinflitta
// (001, 002, ... 010 va bene finché qualcuno non aggiunge 10_qualcosa.sql).
//
// Aggiungere una migrazione = aggiungere un file E una riga qui. Mai modificare
// una migrazione già applicata: il checksum lo rileva e lo logga.
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");

module.exports = [
  { version: "001_init", sql: read("001_init.sql") },
  { version: "002_seed", sql: read("002_seed.sql") },
];
