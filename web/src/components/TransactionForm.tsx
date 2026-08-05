import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, patch, post, fieldErrorsOf, toFormError } from "../api";
import { DASH, money, num, qty as fmtQty } from "../format";
import { useApp } from "../AppContext";
import Money, { DecimalInput, Field, ReadOnlyValue, toDecimal } from "./Money";
import Spinner from "./Spinner";
import WarningsBanner from "./WarningsBanner";
import { TX_TYPES, txTypeLabel } from "./FilterBar";
import type { FormEvent } from "react";
import type { FieldIssue, FormError } from "../api";
import type {
  Amount,
  InstrumentsResponse,
  Transaction,
  TransactionPreview,
  Warning,
} from "../types";

interface TransactionFormProps {
  /** null (o assente) = creazione. */
  transaction?: Transaction | null;
  onSaved?: (saved: Transaction) => void;
  onCancel?: () => void;
}


// Tipi in cui l'importo è inserito direttamente, invece di derivare da quantità ×
// prezzo. Stesso insieme di src/domain/txAmounts.js: se divergesse, il form
// chiederebbe campi che il server ignora.
const AMOUNT_TYPES = new Set([
  "DIVIDEND",
  "COUPON",
  "INTEREST",
  "FEE",
  "TAX",
  "DEPOSIT",
  "WITHDRAWAL",
  "RETURN_OF_CAPITAL",
]);
const INCOME_TYPES = new Set(["DIVIDEND", "COUPON", "INTEREST"]);
const TRADE_TYPES = new Set(["BUY", "SELL"]);
const NO_INSTRUMENT_TYPES = new Set(["DEPOSIT", "WITHDRAWAL"]);

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "SEK", "DKK", "NOK", "CAD", "AUD"];

const PREVIEW_DEBOUNCE_MS = 400;

/** Etichetta dell'importo lordo: la parola giusta cambia con il tipo. */
const GROSS_LABELS: Record<string, string> = {
  DIVIDEND: "Dividendo lordo",
  COUPON: "Cedola lorda",
  INTEREST: "Interessi lordi",
  FEE: "Importo della commissione",
  TAX: "Importo dell'imposta",
  DEPOSIT: "Importo versato",
  WITHDRAWAL: "Importo prelevato",
  RETURN_OF_CAPITAL: "Capitale rimborsato",
};

/**
 * Lo stato del form: TUTTO stringhe, perché è ciò che i campi contengono. Denaro
 * e quantità diventano la forma che il server valida una volta sola, in `payload`.
 */
interface FormState {
  type: string;
  instrumentId: string;
  tradeDate: string;
  settleDate: string;
  quantity: string;
  /** Per i titoli quotati in percentuale è QUESTO il campo primario, non la quantità. */
  nominal: string;
  price: string;
  grossAmount: string;
  fees: string;
  taxes: string;
  accruedInterest: string;
  splitRatio: string;
  tradeCcy: string;
  fxRate: string;
  note: string;
}

/** Il corpo di POST/PATCH /api/transactions e di POST /api/transactions/preview. */
interface TransactionPayload {
  type: string;
  tradeDate: string;
  fees: string;
  taxes: string;
  tradeCcy: string;
  settleDate: string | null;
  note: string | null;
  instrumentId: string | null;
  quantity: Amount;
  nominal: Amount;
  price: Amount;
  grossAmount: Amount;
  accruedInterest: Amount;
  splitRatio: Amount;
  fxRate: Amount;
  portfolioId?: string;
}

const EMPTY_FORM: FormState = {
  type: "BUY",
  instrumentId: "",
  tradeDate: "",
  settleDate: "",
  quantity: "",
  nominal: "",
  price: "",
  grossAmount: "",
  fees: "",
  taxes: "",
  accruedInterest: "",
  splitRatio: "",
  tradeCcy: "EUR",
  fxRate: "",
  note: "",
};

function today() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
    .toISOString()
    .slice(0, 10);
}

/** I numerici possono arrivare come number dal driver: in UI diventano stringhe. */
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function formFromTransaction(tx: Transaction | null | undefined): FormState {
  if (!tx) return { ...EMPTY_FORM, tradeDate: today() };
  return {
    type: tx.type,
    instrumentId: tx.instrumentId == null ? "" : String(tx.instrumentId),
    tradeDate: tx.tradeDate || "",
    settleDate: tx.settleDate || "",
    quantity: str(tx.quantity),
    // Il nominale non è persistito: si ricava dalla quantità solo lato server, e in
    // modifica il campo primario resta la quantità già salvata.
    nominal: "",
    price: str(tx.price),
    grossAmount: str(tx.grossAmount),
    fees: str(tx.fees),
    taxes: str(tx.taxes),
    accruedInterest: str(tx.accruedInterest),
    splitRatio: str(tx.splitRatio),
    tradeCcy: tx.tradeCcy || "EUR",
    fxRate: str(tx.fxRate),
    note: tx.note || "",
  };
}

export default function TransactionForm({ transaction = null, onSaved, onCancel }: TransactionFormProps) {
  const editing = Boolean(transaction?.id);
  const { portfolioId } = useApp();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<FormState>(() => formFromTransaction(transaction));
  // I due campi che il server precompila restano editabili: si tiene traccia di
  // quando l'utente li ha presi in mano, così il valore calcolato continua ad
  // aggiornarsi finché non lo tocca — e dopo non viene più sovrascritto.
  const [accruedTouched, setAccruedTouched] = useState(
    Boolean(transaction?.accruedInterest) && String(transaction?.accruedInterest) !== "0"
  );
  const [fxTouched, setFxTouched] = useState(
    Boolean(transaction?.fxRate) && (transaction?.tradeCcy || "EUR") !== "EUR"
  );
  const [saveError, setSaveError] = useState<FormError | null>(null);

  const set = (patchObj: Partial<FormState>) => setForm((f) => ({ ...f, ...patchObj }));

  const instrumentsQuery = useQuery({
    queryKey: ["instruments", { active: "true" }],
    queryFn: ({ signal }) =>
      get<InstrumentsResponse>("/instruments", { query: { active: "true" }, signal }),
  });
  const instruments = instrumentsQuery.data?.items ?? [];

  const instrument = useMemo(
    () => instruments.find((i) => String(i.id) === form.instrumentId) || null,
    [instruments, form.instrumentId]
  );

  // Modalità obbligazionaria: è la convenzione di quotazione a deciderlo, non la
  // classe. Uno strumento quotato in percentuale di nominale si compila col
  // nominale anche se non è classificato BOND.
  const bondMode = instrument?.quoteConvention === "PCT_OF_NOMINAL";
  const faceValue = instrument?.bond?.faceValue ?? null;

  const showInstrument = !NO_INSTRUMENT_TYPES.has(form.type);
  const isTrade = TRADE_TYPES.has(form.type);
  const isAmount = AMOUNT_TYPES.has(form.type);
  const isIncome = INCOME_TYPES.has(form.type);
  const isSplit = form.type === "SPLIT";
  const showFx = !isSplit;

  // Cambiando tipo si azzerano i campi che quel tipo non usa: un prezzo rimasto in
  // memoria da un BUY finirebbe silenziosamente in un DEPOSIT.
  const onTypeChange = (nextType: string) => {
    setForm((f) => ({
      ...f,
      type: nextType,
      quantity: TRADE_TYPES.has(nextType) ? f.quantity : "",
      nominal: TRADE_TYPES.has(nextType) ? f.nominal : "",
      price: TRADE_TYPES.has(nextType) ? f.price : "",
      accruedInterest: TRADE_TYPES.has(nextType) ? f.accruedInterest : "",
      grossAmount: AMOUNT_TYPES.has(nextType) ? f.grossAmount : "",
      // Commissioni e imposte sopravvivono solo dove il form le mostra: un valore
      // che resta in stato ma non a schermo verrebbe salvato senza che l'utente lo
      // veda.
      taxes: INCOME_TYPES.has(nextType) || TRADE_TYPES.has(nextType) ? f.taxes : "",
      fees: INCOME_TYPES.has(nextType) || TRADE_TYPES.has(nextType) ? f.fees : "",
      splitRatio: nextType === "SPLIT" ? f.splitRatio : "",
      instrumentId: NO_INSTRUMENT_TYPES.has(nextType) ? "" : f.instrumentId,
    }));
  };

  const onInstrumentChange = (nextId: string) => {
    const next = instruments.find((i) => String(i.id) === nextId) || null;
    setForm((f) => ({
      ...f,
      instrumentId: nextId,
      // La valuta segue lo strumento finché l'utente non la cambia a mano: è
      // quasi sempre quella, e ripeterla su ogni movimento è solo un errore in più
      // da fare.
      tradeCcy: next?.currency || f.tradeCcy,
    }));
    setFxTouched(false);
  };

  /**
   * Corpo della richiesta. Denaro e quantità restano STRINGHE: `toDecimal` riscrive
   * la virgola italiana in punto, non converte.
   */
  const payload = useMemo<TransactionPayload>(() => {
    const p: TransactionPayload = {
      type: form.type,
      tradeDate: form.tradeDate,
      // In modifica si invia il record COMPLETO e non solo i campi cambiati: lo
      // schema PATCH del server è `partial()` ma conserva i default, quindi un
      // `fees` non inviato torna a "0" e una `tradeCcy` non inviata torna a "EUR"
      // (verificato con curl). Un payload pieno è l'unico modo sicuro.
      fees: toDecimal(form.fees) ?? "0",
      taxes: toDecimal(form.taxes) ?? "0",
      tradeCcy: form.tradeCcy || "EUR",
      settleDate: form.settleDate ? form.settleDate : null,
      note: form.note ? form.note : null,
      instrumentId: showInstrument && form.instrumentId ? form.instrumentId : null,
      quantity: null,
      nominal: null,
      price: null,
      grossAmount: null,
      accruedInterest: null,
      splitRatio: null,
      fxRate: null,
    };
    if (portfolioId) p.portfolioId = portfolioId;

    if (isTrade) {
      p.price = toDecimal(form.price);
      if (bondMode && toDecimal(form.nominal) !== null) {
        p.nominal = toDecimal(form.nominal);
        // La quantità la deriva il server (nominale / valore facciale): dividere qui
        // significherebbe fare aritmetica decimale in JavaScript.
        p.quantity = null;
      } else {
        p.quantity = toDecimal(form.quantity);
      }
      if (bondMode && accruedTouched) p.accruedInterest = toDecimal(form.accruedInterest);
    }
    if (isAmount) p.grossAmount = toDecimal(form.grossAmount);
    if (isSplit) p.splitRatio = toDecimal(form.splitRatio);
    if (showFx && fxTouched) p.fxRate = toDecimal(form.fxRate);

    return p;
  }, [
    form,
    portfolioId,
    showInstrument,
    isTrade,
    isAmount,
    isSplit,
    showFx,
    bondMode,
    accruedTouched,
    fxTouched,
  ]);

  /** L'anteprima si chiede solo quando il payload ha i campi che il server pretende. */
  const previewReady = useMemo(() => {
    if (!payload.type || !payload.tradeDate) return false;
    if (showInstrument && !payload.instrumentId) return false;
    if (isTrade) return (payload.quantity !== null || payload.nominal !== null) && payload.price !== null;
    if (isSplit) return payload.splitRatio !== null;
    if (isAmount) return payload.grossAmount !== null;
    return false;
  }, [payload, showInstrument, isTrade, isSplit, isAmount]);

  const [preview, setPreview] = useState<TransactionPreview | null>(null);
  const [previewError, setPreviewError] = useState<FormError | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewAbort = useRef<AbortController | null>(null);
  const payloadKey = JSON.stringify(payload);

  useEffect(() => {
    if (!previewReady) {
      setPreview(null);
      setPreviewError(null);
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      previewAbort.current?.abort();
      const controller = new AbortController();
      previewAbort.current = controller;
      setPreviewing(true);
      try {
        const data = await post<TransactionPreview>(
          "/transactions/preview",
          JSON.parse(payloadKey),
          { signal: controller.signal }
        );
        setPreview(data);
        setPreviewError(null);
      } catch (err) {
        // Un abort è l'anteprima precedente che si fa da parte, non un errore.
        if ((err as { name?: string })?.name === "AbortError") return;
        setPreview(null);
        setPreviewError(toFormError(err));
      } finally {
        setPreviewing(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // payloadKey è la forma serializzata del payload: confronta il CONTENUTO, così
    // un re-render che non cambia nulla non rilancia l'anteprima.
  }, [payloadKey, previewReady]);

  useEffect(() => () => previewAbort.current?.abort(), []);

  // In modifica il nominale non arriva dal database (è la quantità che viene
  // persistita), ma in modalità obbligazionaria è il campo primario: si riempie una
  // volta sola col valore che l'anteprima ha derivato, così l'utente ritrova
  // l'importo che il broker gli ha mostrato invece di un campo vuoto. Il ricalcolo
  // sta comunque sul server: qui non si divide nulla.
  const nominalPrefilled = useRef(false);
  useEffect(() => {
    if (!bondMode || nominalPrefilled.current) return;
    if (form.nominal !== "") {
      nominalPrefilled.current = true;
      return;
    }
    if (preview?.nominal) {
      nominalPrefilled.current = true;
      setForm((f) => (f.nominal === "" ? { ...f, nominal: String(preview.nominal) } : f));
    }
  }, [bondMode, preview, form.nominal]);

  const save = useMutation({
    mutationFn: (bodyObj: TransactionPayload) =>
      transaction
        ? patch<Transaction>(`/transactions/${transaction.id}`, bodyObj)
        : post<Transaction>("/transactions", bodyObj),
    onSuccess: (saved) => {
      // Un movimento cambia posizioni, valorizzazione e scadenzario dei redditi:
      // si invalidano i tre prefissi, non le singole chiavi.
      for (const key of [["portfolio"], ["transactions"], ["calendar"]]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      onSaved?.(saved);
    },
    onError: (err) => setSaveError(toFormError(err)),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaveError(null);
    save.mutate(payload);
  };

  // Errori per campo dal 422 del server: `details` è [{field, message}].
  const fieldErrors = useMemo(() => fieldErrorsOf(saveError), [saveError]);
  const issues: FieldIssue[] = Array.isArray(saveError?.details)
    ? (saveError.details as FieldIssue[])
    : [];

  const ccy = preview?.tradeCcy || form.tradeCcy || "EUR";
  const accruedShown = accruedTouched ? form.accruedInterest : str(preview?.accruedInterest);
  const fxShown = fxTouched ? form.fxRate : str(preview?.fxRate);
  const warnings = preview?.warnings ?? [];
  const hasPending = warnings.some((w) => w.pending);

  const currencyOptions = useMemo(() => {
    const set2 = new Set(CURRENCIES);
    for (const i of instruments) if (i.currency) set2.add(i.currency);
    if (form.tradeCcy) set2.add(form.tradeCcy);
    return [...set2].sort();
  }, [instruments, form.tradeCcy]);

  return (
    <form className="tx-form" onSubmit={onSubmit} noValidate>
      {saveError ? (
        <div className="form-error" role="alert">
          {saveError.message}
          {issues.length > 0 ? (
            <ul className="list">
              {issues.map((d, i) => (
                <li key={`${d.field}:${i}`}>
                  <strong>{d.field}</strong>: {d.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="form-grid">
        <Field label="Tipo di movimento" required>
          <select className="select" value={form.type} onChange={(e) => onTypeChange(e.target.value)}>
            {TX_TYPES.map((t) => (
              <option key={t} value={t}>
                {txTypeLabel(t)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Data operazione" required error={fieldErrors.tradeDate}>
          <input
            className="input"
            type="date"
            value={form.tradeDate}
            onChange={(e) => set({ tradeDate: e.target.value })}
          />
        </Field>

        {isTrade ? (
          <Field
            label="Data regolamento"
            hint={bondMode ? "guida il calcolo del rateo" : "facoltativa"}
            error={fieldErrors.settleDate}
          >
            <input
              className="input"
              type="date"
              value={form.settleDate}
              min={form.tradeDate || undefined}
              onChange={(e) => set({ settleDate: e.target.value })}
            />
          </Field>
        ) : null}

        {showInstrument ? (
          <Field label="Strumento" required error={fieldErrors.instrumentId} wide>
            {instrumentsQuery.isPending ? (
              <Spinner label="Strumenti…" />
            ) : (
              <select
                className="select"
                value={form.instrumentId}
                onChange={(e) => onInstrumentChange(e.target.value)}
              >
                <option value="">— seleziona —</option>
                {instruments.map((i) => (
                  <option key={i.id} value={String(i.id)}>
                    {[i.ticker || i.isin, i.name].filter(Boolean).join(" — ")}
                  </option>
                ))}
              </select>
            )}
            {instrumentsQuery.error ? (
              <span className="field-error">
                Elenco strumenti non disponibile: {instrumentsQuery.error.message}
              </span>
            ) : null}
          </Field>
        ) : null}
      </div>

      {/* --- Compravendita --- */}
      {isTrade ? (
        <fieldset className="form-section">
          <legend>{form.type === "BUY" ? "Acquisto" : "Vendita"}</legend>

          {bondMode ? (
            <p className="form-note">
              Strumento quotato in <strong>percentuale del nominale</strong>: si inserisce il
              nominale, cioè l'importo che compare sull'eseguito del broker. La quantità di
              titoli la calcola il server come nominale ÷ valore facciale
              {faceValue !== null ? <> ({num(faceValue, 2)})</> : null}.
            </p>
          ) : null}

          <div className="form-grid">
            {bondMode ? (
              <>
                <Field label="Nominale" required error={fieldErrors.quantity}>
                  <DecimalInput
                    value={form.nominal}
                    onChange={(v) => set({ nominal: v })}
                    placeholder="10000"
                  />
                </Field>
                <Field label="Quantità (derivata)" hint="nominale ÷ valore facciale">
                  <ReadOnlyValue title="Calcolata dal server">
                    {preview?.quantity ? fmtQty(preview.quantity) : DASH}
                  </ReadOnlyValue>
                </Field>
                <Field label="Corso secco (% del nominale)" required error={fieldErrors.price}>
                  <DecimalInput
                    value={form.price}
                    onChange={(v) => set({ price: v })}
                    placeholder="98,75"
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="Quantità" required error={fieldErrors.quantity}>
                  <DecimalInput
                    value={form.quantity}
                    onChange={(v) => set({ quantity: v })}
                    placeholder="25"
                  />
                </Field>
                <Field label="Prezzo unitario" required error={fieldErrors.price}>
                  <DecimalInput
                    value={form.price}
                    onChange={(v) => set({ price: v })}
                    placeholder="95,40"
                  />
                </Field>
              </>
            )}

            <Field label="Commissioni" hint="in acquisto aumentano il carico">
              <DecimalInput value={form.fees} onChange={(v) => set({ fees: v })} placeholder="0" />
            </Field>

            <Field label="Imposte">
              <DecimalInput value={form.taxes} onChange={(v) => set({ taxes: v })} placeholder="0" />
            </Field>

            {bondMode ? (
              <Field
                label="Rateo cedolare"
                hint={
                  preview?.accruedAuto
                    ? "calcolato dallo scadenzario, modificabile"
                    : "escluso dal costo di carico"
                }
              >
                <DecimalInput
                  value={accruedShown}
                  onChange={(v) => {
                    setAccruedTouched(true);
                    set({ accruedInterest: v });
                  }}
                  placeholder="0"
                />
                {accruedTouched ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={() => {
                      setAccruedTouched(false);
                      set({ accruedInterest: "" });
                    }}
                  >
                    Ricalcola dal server
                  </button>
                ) : null}
              </Field>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      {/* --- Redditi: lordo e ritenuta separati, MAI un solo campo "netto" --- */}
      {isAmount ? (
        <fieldset className="form-section">
          <legend>{isIncome ? "Reddito" : "Importo"}</legend>
          {isIncome ? (
            <p className="form-note">
              Si inserisce il <strong>lordo</strong> e la <strong>ritenuta</strong> separatamente:
              il netto è una sottrazione che fa il server. Un unico campo "netto" renderebbe
              impossibile ricostruire la ritenuta subita.
            </p>
          ) : null}
          <div className="form-grid">
            <Field
              label={GROSS_LABELS[form.type] || "Importo lordo"}
              required
              error={fieldErrors.grossAmount}
            >
              <DecimalInput
                value={form.grossAmount}
                onChange={(v) => set({ grossAmount: v })}
                placeholder="0,00"
              />
            </Field>
            {isIncome ? (
              <>
                <Field label="Ritenuta" hint="imposta trattenuta alla fonte">
                  <DecimalInput
                    value={form.taxes}
                    onChange={(v) => set({ taxes: v })}
                    placeholder="0"
                  />
                </Field>
                <Field label="Commissioni">
                  <DecimalInput
                    value={form.fees}
                    onChange={(v) => set({ fees: v })}
                    placeholder="0"
                  />
                </Field>
              </>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      {/* --- Split: nessun movimento di cassa --- */}
      {isSplit ? (
        <fieldset className="form-section">
          <legend>Split</legend>
          <p className="form-note">
            Rapporto di conversione: 4 per uno split 4:1 (una quota diventa quattro), 0,5 per un
            raggruppamento 1:2. Non genera movimenti di cassa e non tocca il costo di carico.
          </p>
          <div className="form-grid">
            <Field label="Rapporto di conversione" required error={fieldErrors.splitRatio}>
              <DecimalInput
                value={form.splitRatio}
                onChange={(v) => set({ splitRatio: v })}
                placeholder="4"
              />
            </Field>
          </div>
        </fieldset>
      ) : null}

      {/* --- Valuta e cambio --- */}
      {showFx ? (
        <fieldset className="form-section">
          <legend>Valuta</legend>
          <div className="form-grid">
            <Field label="Valuta dell'operazione" error={fieldErrors.tradeCcy}>
              <select
                className="select"
                value={form.tradeCcy}
                onChange={(e) => {
                  set({ tradeCcy: e.target.value });
                  setFxTouched(false);
                }}
              >
                {currencyOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            {form.tradeCcy !== "EUR" ? (
              <Field
                label={`Cambio EUR/${form.tradeCcy}`}
                hint={`unità di ${form.tradeCcy} per 1 EUR${
                  preview?.fxSource ? ` · fonte: ${preview.fxSource}` : ""
                }`}
                error={fieldErrors.fxRate}
              >
                <DecimalInput
                  value={fxShown}
                  onChange={(v) => {
                    setFxTouched(true);
                    set({ fxRate: v });
                  }}
                  placeholder="1,0850"
                />
                {fxTouched ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={() => {
                      setFxTouched(false);
                      set({ fxRate: "" });
                    }}
                  >
                    Usa il cambio in cache
                  </button>
                ) : null}
              </Field>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      <Field label="Nota">
        <input
          className="input"
          type="text"
          maxLength={2000}
          value={form.note}
          onChange={(e) => set({ note: e.target.value })}
        />
      </Field>

      <PreviewPanel
        ready={previewReady}
        loading={previewing}
        preview={preview}
        error={previewError}
        warnings={warnings}
        hasPending={hasPending}
        ccy={ccy}
        bondMode={bondMode}
        editing={editing}
      />

      <div className="row form-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={save.isPending}>
          Annulla
        </button>
        <button type="submit" className="btn btn--primary" disabled={save.isPending || !previewReady}>
          {save.isPending ? (
            <Spinner inline label="Salvataggio…" />
          ) : editing ? (
            "Salva modifiche"
          ) : (
            "Registra movimento"
          )}
        </button>
      </div>
    </form>
  );
}

/**
 * Pannello del risultato: ciò che il server calcolerà, prima di salvare.
 *
 * Gli avvisi stanno IN CIMA e con role="alert": l'oversell si deve vedere prima di
 * confermare, non scoprire dopo nel ledger.
 */
interface PreviewPanelProps {
  /** false finché il payload non ha i campi che il server pretende. */
  ready: boolean;
  loading: boolean;
  preview: TransactionPreview | null;
  error: FormError | null;
  warnings: Warning[];
  /** true se un avviso riguarda l'operazione in corso, non il ledger esistente. */
  hasPending: boolean;
  ccy: string;
  bondMode: boolean;
  editing: boolean;
}

function PreviewPanel({
  ready,
  loading,
  preview,
  error,
  warnings,
  hasPending,
  ccy,
  bondMode,
  editing,
}: PreviewPanelProps) {
  if (!ready) {
    return (
      <div className="preview preview--idle">
        <p className="muted small">
          Compila i campi obbligatori: importi, rateo e posizione risultante vengono calcolati dal
          server mentre scrivi.
        </p>
      </div>
    );
  }

  if (error) {
    const issues: FieldIssue[] = Array.isArray(error.details)
      ? (error.details as FieldIssue[])
      : [];
    return (
      <div className="preview preview--idle">
        <p className="muted small">
          Anteprima non disponibile: {error.message}
          {issues.length > 0
            ? ` (${issues.map((d) => `${d.field}: ${d.message}`).join("; ")})`
            : ""}
        </p>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="preview preview--idle">
        <Spinner label="Calcolo dell'anteprima…" />
      </div>
    );
  }

  const pos = preview.resultingPosition;

  return (
    <div className={loading ? "preview preview--loading" : "preview"}>
      <div className="preview-head">
        <h3 className="preview-title">Risultato dell'operazione</h3>
        {loading ? <Spinner inline label="Aggiornamento…" /> : null}
      </div>

      {warnings.length > 0 ? (
        <div className="preview-warnings" role="alert">
          <p className="preview-warnings-title">
            {hasPending
              ? "Questa operazione genera avvisi — leggili prima di salvare"
              : "Avvisi sul ricalcolo"}
          </p>
          <WarningsBanner warnings={warnings} />
        </div>
      ) : null}

      <dl className="preview-grid">
        <div>
          <dt>Importo lordo</dt>
          <dd>
            <Money value={preview.grossAmount} ccy={ccy} />
          </dd>
        </div>
        <div>
          <dt>Effetto di cassa (netto)</dt>
          <dd>
            <Money value={preview.netAmount} ccy={ccy} withSign tone />
          </dd>
        </div>
        {bondMode ? (
          <>
            <div>
              <dt>
                Rateo cedolare{" "}
                {preview.accruedAuto ? <span className="badge badge--calc">calcolato</span> : null}
              </dt>
              <dd>
                <Money value={preview.accruedInterest} ccy={ccy} />
              </dd>
            </div>
            <div>
              <dt>Nominale · quantità</dt>
              <dd className="num">
                {preview.nominal ? num(preview.nominal, 2) : DASH} ·{" "}
                {preview.quantity ? fmtQty(preview.quantity) : DASH}
              </dd>
            </div>
          </>
        ) : null}
        {ccy !== "EUR" ? (
          <div>
            <dt>Cambio EUR/{ccy}</dt>
            <dd className="num">
              {preview.fxRate ? num(preview.fxRate, 6) : DASH}
              {preview.fxSource ? <span className="muted small"> · {preview.fxSource}</span> : null}
            </dd>
          </div>
        ) : null}
      </dl>

      {pos ? (
        <div className="preview-position">
          <h4 className="preview-subtitle">Posizione risultante</h4>
          {editing ? (
            // L'anteprima aggiunge l'operazione al ledger che GIÀ la contiene: gli
            // importi restano corretti, la posizione risultante conta due volte
            // questo movimento. Meglio dirlo che mostrare un numero credibile e
            // sbagliato.
            <p className="muted small">
              In modifica la posizione risultante somma questa operazione al ledger che la
              contiene già: usala per confrontare, non come saldo finale.
            </p>
          ) : null}
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col" className="cell-right">
                  Prima
                </th>
                <th scope="col" className="cell-right">
                  Dopo
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Quantità</th>
                <td className="cell-right num">{fmtQty(pos.quantityBefore)}</td>
                <td className="cell-right num">{fmtQty(pos.quantityAfter)}</td>
              </tr>
              <tr>
                <th scope="row">Costo di carico</th>
                <td className="cell-right">{money(pos.costBasisBefore, ccy)}</td>
                <td className="cell-right">{money(pos.costBasisAfter, ccy)}</td>
              </tr>
              <tr>
                <th scope="row">Costo medio dopo</th>
                <td className="cell-right muted">{DASH}</td>
                <td className="cell-right">{money(pos.avgCostAfter, ccy)}</td>
              </tr>
              <tr>
                <th scope="row">Plusvalenza realizzata</th>
                <td className="cell-right muted">{DASH}</td>
                <td className="cell-right">
                  <Money value={pos.realizedPnlDelta} ccy={ccy} withSign tone />
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">
            Plusvalenza realizzata, redditi e plusvalenza latente restano voci separate: non
            vengono mai sommate in un unico profitto. Questa app non fornisce consulenza fiscale.
          </p>
        </div>
      ) : null}
    </div>
  );
}
