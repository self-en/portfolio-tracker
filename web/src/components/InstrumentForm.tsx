import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patch, post } from "../api";
import { num } from "../format";
import { DecimalInput, Field, toDecimal } from "./Money";
import Spinner from "./Spinner";
import SymbolSearch from "./SymbolSearch";
import type { Instrument } from "../types";

interface InstrumentFormProps {
  instrument?: Instrument;
  onSaved?: (...args: any[]) => void;
  onCancel?: (...args: any[]) => void;
}


const ASSET_CLASSES = [
  ["EQUITY", "Azione"],
  ["ETF", "ETF"],
  ["BOND", "Obbligazione"],
  ["FUND", "Fondo"],
  ["CRYPTO", "Cripto"],
  ["CASH", "Liquidità"],
];

const DAY_COUNTS = ["ACT/ACT-ICMA", "30E/360", "ACT/365F", "ACT/360"];

const COUPON_FREQUENCIES = [
  ["2", "Semestrale (2)"],
  ["1", "Annuale (1)"],
  ["4", "Trimestrale (4)"],
  ["12", "Mensile (12)"],
  ["0", "Zero coupon (0)"],
];

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "SEK", "DKK", "NOK", "CAD", "AUD"];

/**
 * Percentuale → frazione: "3,45" → "0.0345".
 *
 * Sposta la virgola di due posizioni a SINISTRA operando sulla stringa. Un `/100`
 * su un double introdurrebbe l'errore di rappresentazione proprio nel tasso che il
 * database conserva come frazione esatta (docs/decisions.md §9).
 */
export function pctToFraction(input) {
  const s = toDecimal(input);
  if (s === null) return null;
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [intRaw = "0", frac = ""] = body.split(".");
  const padded = intRaw.padStart(3, "0");
  const cut = padded.length - 2;
  const head = padded.slice(0, cut).replace(/^0+(?=\d)/, "");
  let out = `${head}.${padded.slice(cut)}${frac}`.replace(/0+$/, "");
  if (out.endsWith(".")) out = out.slice(0, -1);
  return (neg ? "-" : "") + out;
}

/** Frazione → percentuale: "0.0345" → "3.45". L'inverso, sempre sulla stringa. */
export function fractionToPct(value) {
  const s = toDecimal(value);
  if (s === null) return "";
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [intRaw = "0", fracRaw = ""] = body.split(".");
  const frac = fracRaw.padEnd(2, "0");
  const head = (intRaw + frac.slice(0, 2)).replace(/^0+(?=\d)/, "");
  const rest = frac.slice(2).replace(/0+$/, "");
  return (neg ? "-" : "") + (rest ? `${head}.${rest}` : head);
}

const str = (v) => (v === null || v === undefined ? "" : String(v));

const EMPTY = {
  assetClass: "ETF",
  name: "",
  ticker: "",
  isin: "",
  exchange: "",
  currency: "EUR",
  priceSource: "yahoo",
  quoteConvention: "PRICE",
  faceValue: "",
  couponRatePct: "",
  couponFrequency: "2",
  firstCouponDate: "",
  maturityDate: "",
  dayCount: "ACT/ACT-ICMA",
  issuer: "",
  notes: "",
  active: true,
};

function formFromInstrument(inst) {
  if (!inst) return { ...EMPTY };
  const bond = inst.bond || {};
  return {
    assetClass: inst.assetClass,
    name: inst.name || "",
    ticker: inst.ticker || "",
    isin: inst.isin || "",
    exchange: inst.exchange || "",
    currency: inst.currency || "EUR",
    priceSource: inst.priceSource || "yahoo",
    quoteConvention: inst.quoteConvention || "PRICE",
    faceValue: str(bond.faceValue),
    // Il database tiene la FRAZIONE, l'utente ragiona in percentuale: la
    // conversione è visibile sotto il campo, non nascosta.
    couponRatePct: fractionToPct(bond.couponRate),
    couponFrequency: bond.couponFrequency === null || bond.couponFrequency === undefined
      ? "2"
      : String(bond.couponFrequency),
    firstCouponDate: bond.firstCouponDate || "",
    maturityDate: bond.maturityDate || "",
    dayCount: bond.dayCount || "ACT/ACT-ICMA",
    issuer: inst.issuer || "",
    notes: inst.notes || "",
    active: inst.active !== false,
  };
}

export default function InstrumentForm({ instrument = null, onSaved, onCancel }: InstrumentFormProps) {
  const editing = Boolean(instrument?.id);
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => formFromInstrument(instrument));
  const [error, setError] = useState(null);

  const set = (patchObj) => setForm((f) => ({ ...f, ...patchObj }));

  const isBond = form.assetClass === "BOND";
  const showBondFields = isBond || form.quoteConvention === "PCT_OF_NOMINAL";
  const zeroCoupon = form.couponFrequency === "0";

  // Le obbligazioni non hanno copertura di mercato (verificato: Yahoo restituisce
  // zero risultati sui BTP). Passando a BOND si propone subito il pricing manuale e
  // la quotazione in percentuale di nominale, che è la coppia corretta.
  const onAssetClassChange = (next) => {
    if (next === "BOND") {
      set({
        assetClass: next,
        priceSource: "manual",
        quoteConvention: "PCT_OF_NOMINAL",
        faceValue: form.faceValue || "1000",
      });
    } else {
      set({ assetClass: next });
    }
  };

  const couponFraction = useMemo(() => pctToFraction(form.couponRatePct), [form.couponRatePct]);

  const payload = useMemo(() => {
    // Si invia sempre l'insieme completo: lo schema PATCH del server è `partial()`
    // ma conserva i default degli enum, quindi omettere `priceSource` lo riporta a
    // "yahoo" — su un'obbligazione manuale il salvataggio verrebbe rifiutato
    // (verificato con curl).
    const p = {
      assetClass: form.assetClass,
      name: form.name.trim(),
      ticker: form.ticker.trim() || null,
      isin: form.isin.trim().toUpperCase() || null,
      exchange: form.exchange.trim() || null,
      currency: form.currency,
      priceSource: form.priceSource,
      quoteConvention: form.quoteConvention,
      issuer: form.issuer.trim() || null,
      notes: form.notes.trim() || null,
      active: form.active,
      // `metadata` non è editabile qui, ma va rispedito: anche lui ha un default
      // ({}) che una PATCH senza il campo applicherebbe, cancellando quanto
      // arrivato da un import.
      metadata: instrument?.metadata ?? {},
      faceValue: null,
      couponRate: null,
      couponFrequency: null,
      firstCouponDate: null,
      maturityDate: null,
      dayCount: null,
    };
    if (showBondFields) {
      p.faceValue = toDecimal(form.faceValue);
      // La frequenza resta la stringa del select: lo schema del server accetta
      // stringa o numero, e qui non serve introdurre una conversione.
      p.couponFrequency = form.couponFrequency === "" ? null : form.couponFrequency;
      p.maturityDate = form.maturityDate || null;
      p.dayCount = form.dayCount || null;
      if (!zeroCoupon) {
        p.couponRate = couponFraction;
        p.firstCouponDate = form.firstCouponDate || null;
      }
    }
    return p;
  }, [form, showBondFields, zeroCoupon, couponFraction]);

  const save = useMutation({
    mutationFn: (bodyObj) =>
      editing ? patch(`/instruments/${instrument.id}`, bodyObj) : post("/instruments", bodyObj),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["instruments"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["calendar"] });
      onSaved?.(saved);
    },
    onError: (err) => setError(err),
  });

  const fieldErrors = useMemo(() => {
    const out = {};
    if (Array.isArray(error?.details)) {
      for (const d of error.details) if (d?.field) out[d.field] = d.message;
    }
    return out;
  }, [error]);

  const onSubmit = (e) => {
    e.preventDefault();
    setError(null);
    save.mutate(payload);
  };

  const onSymbolSelect = (hit) => {
    set({
      ticker: hit.symbol || form.ticker,
      name: form.name || hit.name || "",
      exchange: hit.exchange || form.exchange,
      currency: hit.currency || form.currency,
    });
  };

  return (
    <form className="tx-form" onSubmit={onSubmit} noValidate>
      {error ? (
        <div className="form-error" role="alert">
          {error.message}
          {error.code === "conflict" && error.details?.name ? (
            <p className="small">
              Esiste già: {error.details.name}
              {error.details.isin ? ` (${error.details.isin})` : ""}.
            </p>
          ) : null}
          {Array.isArray(error.details) && error.details.length > 0 ? (
            <ul className="list">
              {error.details.map((d, i) => (
                <li key={`${d.field}:${i}`}>
                  <strong>{d.field}</strong>: {d.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {!editing ? <SymbolSearch onSelect={onSymbolSelect} /> : null}

      <div className="form-grid">
        <Field label="Classe" required>
          <select
            className="select"
            value={form.assetClass}
            onChange={(e) => onAssetClassChange(e.target.value)}
          >
            {ASSET_CLASSES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Nome" required error={fieldErrors.name} wide>
          <input
            className="input"
            type="text"
            maxLength={200}
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>

        <Field label="Ticker" hint="serve almeno un ticker o un ISIN" error={fieldErrors.ticker}>
          <input
            className="input"
            type="text"
            maxLength={40}
            value={form.ticker}
            onChange={(e) => set({ ticker: e.target.value })}
          />
        </Field>

        <Field label="ISIN" error={fieldErrors.isin}>
          <input
            className="input"
            type="text"
            maxLength={12}
            placeholder="IT0005611741"
            value={form.isin}
            onChange={(e) => set({ isin: e.target.value.toUpperCase() })}
          />
        </Field>

        <Field label="Borsa" error={fieldErrors.exchange}>
          <input
            className="input"
            type="text"
            maxLength={40}
            value={form.exchange}
            onChange={(e) => set({ exchange: e.target.value })}
          />
        </Field>

        <Field label="Valuta" required error={fieldErrors.currency}>
          <select
            className="select"
            value={form.currency}
            onChange={(e) => set({ currency: e.target.value })}
          >
            {[...new Set([...CURRENCIES, form.currency])].sort().map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Sorgente del prezzo" error={fieldErrors.priceSource}>
          <select
            className="select"
            value={form.priceSource}
            onChange={(e) => set({ priceSource: e.target.value })}
          >
            <option value="yahoo">Provider di mercato (Yahoo)</option>
            <option value="manual">Manuale</option>
          </select>
        </Field>

        <Field label="Convenzione di quotazione" error={fieldErrors.quoteConvention}>
          <select
            className="select"
            value={form.quoteConvention}
            onChange={(e) => set({ quoteConvention: e.target.value })}
          >
            <option value="PRICE">Prezzo per quota</option>
            <option value="PCT_OF_NOMINAL">Percentuale del nominale</option>
          </select>
        </Field>
      </div>

      {isBond && form.priceSource === "yahoo" ? (
        <p className="form-note form-note--warn">
          Le obbligazioni non hanno copertura di mercato: il provider restituisce zero risultati
          sui titoli di Stato. Imposta <strong>sorgente manuale</strong> e aggiorna il corso dalla
          scheda dello strumento.{" "}
          <button
            type="button"
            className="btn btn--small"
            onClick={() => set({ priceSource: "manual" })}
          >
            Usa sorgente manuale
          </button>
        </p>
      ) : null}

      {showBondFields ? (
        <fieldset className="form-section">
          <legend>Dati obbligazionari</legend>
          <div className="form-grid">
            <Field
              label="Valore facciale"
              required
              hint="nominale di un titolo (1.000 per i BTP)"
              error={fieldErrors.faceValue}
            >
              <DecimalInput
                value={form.faceValue}
                onChange={(v) => set({ faceValue: v })}
                placeholder="1000"
              />
            </Field>

            <Field label="Frequenza cedolare" required error={fieldErrors.couponFrequency}>
              <select
                className="select"
                value={form.couponFrequency}
                onChange={(e) => set({ couponFrequency: e.target.value })}
              >
                {COUPON_FREQUENCIES.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>

            {!zeroCoupon ? (
              <Field
                label="Tasso cedolare annuo (%)"
                required
                hint={
                  couponFraction
                    ? `si inserisce in percentuale: ${num(form.couponRatePct.replace(",", "."), 3)} % → frazione ${couponFraction} inviata all'API`
                    : "in percentuale, es. 3,45"
                }
                error={fieldErrors.couponRate}
              >
                <DecimalInput
                  value={form.couponRatePct}
                  onChange={(v) => set({ couponRatePct: v })}
                  placeholder="3,45"
                />
              </Field>
            ) : null}

            {!zeroCoupon ? (
              <Field
                label="Data prima cedola"
                required
                hint="godimento o prima cedola pagata"
                error={fieldErrors.firstCouponDate}
              >
                <input
                  className="input"
                  type="date"
                  value={form.firstCouponDate}
                  max={form.maturityDate || undefined}
                  onChange={(e) => set({ firstCouponDate: e.target.value })}
                />
              </Field>
            ) : null}

            <Field label="Scadenza" required error={fieldErrors.maturityDate}>
              <input
                className="input"
                type="date"
                value={form.maturityDate}
                min={form.firstCouponDate || undefined}
                onChange={(e) => set({ maturityDate: e.target.value })}
              />
            </Field>

            <Field label="Convenzione giorni" error={fieldErrors.dayCount}>
              <select
                className="select"
                value={form.dayCount}
                onChange={(e) => set({ dayCount: e.target.value })}
              >
                {DAY_COUNTS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Emittente" error={fieldErrors.issuer}>
              <input
                className="input"
                type="text"
                maxLength={200}
                value={form.issuer}
                onChange={(e) => set({ issuer: e.target.value })}
              />
            </Field>
          </div>
          <p className="muted small">
            Lo scadenzario cedolare viene rigenerato a ogni modifica di questi campi: è ciò che
            popola il calendario delle cedole, dove il provider non arriva.
          </p>
        </fieldset>
      ) : null}

      <Field label="Note">
        <textarea
          className="input"
          rows={2}
          maxLength={4000}
          value={form.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </Field>

      <label className="field field--check">
        <input
          type="checkbox"
          checked={form.active}
          onChange={(e) => set({ active: e.target.checked })}
        />
        <span>Attivo (uno strumento disattivato resta nello storico ma non viene aggiornato)</span>
      </label>

      <div className="row form-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={save.isPending}>
          Annulla
        </button>
        <button type="submit" className="btn btn--primary" disabled={save.isPending}>
          {save.isPending ? (
            <Spinner inline label="Salvataggio…" />
          ) : editing ? (
            "Salva modifiche"
          ) : (
            "Crea strumento"
          )}
        </button>
      </div>
    </form>
  );
}
