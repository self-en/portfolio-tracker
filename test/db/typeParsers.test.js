// I type parser di `pg` verificati DIRETTAMENTE, senza database.
//
// Serve perché pg-mem non passa dal protocollo wire e quindi non può dimostrare
// questo contratto (vedi la nota in test/repo/repo.test.js), mentre è il contratto
// da cui dipende tutta la correttezza numerica dell'app (docs/decisions.md §1).
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_PASSWORD = "test";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789";

// Il require registra i parser come effetto collaterale globale su `pg`.
require("../../src/db/pool");
const { types } = require("pg");

const OID = { NUMERIC: 1700, INT8: 20, DATE: 1082 };

test("NUMERIC (1700) resta una STRINGA: il default parseFloat distruggerebbe la precisione", () => {
  const parse = types.getTypeParser(OID.NUMERIC);
  assert.equal(parse("1234.56789012345678"), "1234.56789012345678");
  assert.equal(typeof parse("0.1"), "string");
  // Il valore che parseFloat rovinerebbe.
  assert.equal(parse("9007199254740993.5"), "9007199254740993.5");
  assert.notEqual(parse("0.1"), 0.1);
});

test("INT8 (20) resta una STRINGA: un bigint non entra in un Number in sicurezza", () => {
  const parse = types.getTypeParser(OID.INT8);
  assert.equal(parse("9223372036854775807"), "9223372036854775807");
  assert.equal(typeof parse("42"), "string");
});

test("DATE (1082) resta 'YYYY-MM-DD' e NON diventa un Date a mezzanotte locale", () => {
  // È l'override che tutti dimenticano: il default di pg costruisce un Date a
  // mezzanotte LOCALE, e un toISOString() a valle trasforma 2026-01-01 in
  // 2025-12-31 per chiunque stia a est di Greenwich.
  const parse = types.getTypeParser(OID.DATE);
  assert.equal(parse("2026-01-01"), "2026-01-01");
  assert.equal(typeof parse("2026-01-01"), "string");
  assert.ok(!(parse("2026-01-01") instanceof Date));

  // La dimostrazione del bug che l'override evita.
  const brokenDefault = new Date("2026-01-01 00:00:00");
  const roundTripped = brokenDefault.toISOString().slice(0, 10);
  assert.equal(
    parse("2026-01-01"),
    "2026-01-01",
    `il parser corretto conserva la data; il default produrrebbe ${roundTripped}`
  );
});

test("i tre parser sono l'identità, non trasformazioni", () => {
  for (const oid of Object.values(OID)) {
    const parse = types.getTypeParser(oid);
    for (const v of ["0", "-1.5", "2026-02-29", ""]) {
      assert.equal(parse(v), v, `OID ${oid} ha alterato ${JSON.stringify(v)}`);
    }
  }
});
