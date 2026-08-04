// Auth: firma/verifica/scadenza/tamper. Puro, nessun I/O, nessun HTTP.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_PASSWORD = process.env.APP_PASSWORD || "test-password";
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "0123456789abcdef0123456789abcdef0123456789";

const { signToken, verifyToken, verifyPassword, safeEqual } = require("../../src/http/auth");

const SECRET = "un-segreto-di-almeno-32-caratteri-abcdef";
const OTHER = "un-ALTRO-segreto-di-almeno-32-caratteri!";

test("signToken → verifyToken fa round-trip e conserva sid", () => {
  const { token, sid } = signToken({ secret: SECRET, now: 1_700_000_000_000, ttlDays: 30 });
  const r = verifyToken(token, { secret: SECRET, now: 1_700_000_000_000 });
  assert.equal(r.ok, true);
  assert.equal(r.payload.sid, sid);
  assert.equal(r.payload.v, 1);
});

test("expiresAt riflette il TTL richiesto", () => {
  const now = 1_700_000_000_000;
  const { expiresAt } = signToken({ secret: SECRET, now, ttlDays: 30 });
  const expected = new Date(Math.floor(now / 1000) * 1000 + 30 * 86400_000).toISOString();
  assert.equal(expiresAt, expected);
});

test("un token scaduto viene rifiutato con reason 'expired'", () => {
  const now = 1_700_000_000_000;
  const { token } = signToken({ secret: SECRET, now, ttlDays: 1 });
  const later = now + 2 * 86400_000;
  const r = verifyToken(token, { secret: SECRET, now: later });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
});

test("un token valido esattamente al secondo di scadenza è rifiutato (confine chiuso)", () => {
  const now = 1_700_000_000_000;
  const { token, exp } = signToken({ secret: SECRET, now, ttlDays: 1 });
  assert.equal(verifyToken(token, { secret: SECRET, now: exp * 1000 - 1 }).ok, true);
  assert.equal(verifyToken(token, { secret: SECRET, now: exp * 1000 }).ok, false);
});

test("un segreto diverso invalida la firma", () => {
  const { token } = signToken({ secret: SECRET, now: 1_700_000_000_000 });
  const r = verifyToken(token, { secret: OTHER, now: 1_700_000_000_000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_signature");
});

test("manomettere il payload invalida la firma (non si può estendere exp)", () => {
  const now = 1_700_000_000_000;
  const { token } = signToken({ secret: SECRET, now, ttlDays: 1 });
  const [payloadB64, sig] = token.split(".");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  payload.exp += 10 * 86400; // l'attaccante si allunga la sessione
  const forged =
    Buffer.from(JSON.stringify(payload)).toString("base64url") + "." + sig;
  const r = verifyToken(forged, { secret: SECRET, now });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_signature");
});

test("token malformati non lanciano, restituiscono un esito", () => {
  for (const bad of [
    undefined,
    null,
    "",
    "senzapunto",
    ".soloSig",
    "soloPayload.",
    "a.b",
    "{}",
    Buffer.from("{}").toString("base64url") + ".x",
    123,
    {},
  ]) {
    const r = verifyToken(bad, { secret: SECRET, now: 1 });
    assert.equal(r.ok, false, `atteso rifiuto per ${JSON.stringify(bad)}`);
    assert.equal(typeof r.reason, "string");
  }
});

test("un payload firmato correttamente ma con v diversa è rifiutato", () => {
  const crypto = require("node:crypto");
  const payload = Buffer.from(
    JSON.stringify({ v: 2, iat: 1, exp: 9_999_999_999, sid: "x" })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  const r = verifyToken(`${payload}.${sig}`, { secret: SECRET, now: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_version");
});

test("verifyPassword accetta quella giusta e rifiuta le altre", () => {
  const cfg = { appPassword: "correct horse battery", sessionSecret: SECRET };
  assert.equal(verifyPassword("correct horse battery", cfg), true);
  assert.equal(verifyPassword("correct horse batter", cfg), false);
  assert.equal(verifyPassword("", cfg), false);
  assert.equal(verifyPassword("CORRECT HORSE BATTERY", cfg), false);
});

test("verifyPassword è false se la config è incompleta (locked mode, non un bypass)", () => {
  assert.equal(verifyPassword("qualunque", { appPassword: "", sessionSecret: SECRET }), false);
  assert.equal(verifyPassword("qualunque", { appPassword: "x", sessionSecret: "" }), false);
  assert.equal(verifyPassword("", { appPassword: "", sessionSecret: "" }), false);
});

test("safeEqual non lancia su lunghezze diverse", () => {
  assert.equal(safeEqual(Buffer.from("abc"), Buffer.from("abcd")), false);
  assert.equal(safeEqual(Buffer.from(""), Buffer.from("a")), false);
  assert.equal(safeEqual(Buffer.from("abc"), Buffer.from("abc")), true);
});
