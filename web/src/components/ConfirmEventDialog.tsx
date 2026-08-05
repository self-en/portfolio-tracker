import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post } from "../api";
import { date, money, num, qty } from "../format";
import { useToast } from "./Toast";
import type { CalendarEvent } from "../types";

interface ConfirmEventDialogProps {
  event: CalendarEvent;
  portfolioId?: any;
  onClose?: (...args: any[]) => void;
}


// IL FLUSSO A PIÙ ALTO VALORE DELL'APP.
//
// In un'applicazione a inserimento manuale il calendario è il canale PRIMARIO di
// data entry: l'utente vede "cedola BTP il 1° luglio, ~172,50", conferma, e il
// movimento è registrato. Il lordo arriva precompilato dallo scadenzario, la
// ritenuta è l'unica cosa da inserire — con un suggerimento, perché ricordare a
// memoria 12,5% o 26% è precisamente ciò che fa rimandare l'inserimento.

// ---------------------------------------------------------------------------
// Aritmetica decimale su BigInt.
//
// Il suggerimento della ritenuta è una moltiplicazione su denaro, e sul denaro
// non si passa da un float (docs/decisions.md §1): decimal.js non è tra le
// dipendenze del frontend, quindi la percentuale si calcola su interi arbitrari
// con arrotondamento del banchiere, esattamente come fa il server.
// ---------------------------------------------------------------------------

/** "172.50" → { sign, digits: 17250n, scale: 2 }. null se non è un decimale. */
function parseDecimal(input) {
  const s = String(input ?? "").trim();
  const m = /^([+-]?)(\d*)(?:[.,](\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  const frac = m[3] ?? "";
  return {
    negative: m[1] === "-",
    digits: BigInt((m[2] || "0") + frac),
    scale: frac.length,
  };
}

function render(scaled, dp) {
  const negative = scaled < 0n;
  const abs = (negative ? -scaled : scaled).toString().padStart(dp + 1, "0");
  const int = abs.slice(0, abs.length - dp);
  const frac = dp === 0 ? "" : `.${abs.slice(abs.length - dp)}`;
  return `${negative ? "-" : ""}${int}${frac}`;
}

/** Riscala a 2 decimali con ROUND_HALF_EVEN, come il denaro sul server. */
function toCents(scaled, scale) {
  if (scale <= 2) return scaled * 10n ** BigInt(2 - scale);
  const divisor = 10n ** BigInt(scale - 2);
  const q = scaled / divisor;
  const rest = scaled % divisor;
  const doubled = (rest < 0n ? -rest : rest) * 2n;
  let bump = 0n;
  if (doubled > divisor) bump = 1n;
  else if (doubled === divisor && q % 2n !== 0n) bump = 1n;
  return q + (scaled < 0n ? -bump : bump);
}

const signed = (p) => (p.negative ? -p.digits : p.digits);

/** `amount` × `ratePercent`% → stringa a 2 decimali. null su input non validi. */
export function percentOf(amount, ratePercent) {
  const a = parseDecimal(amount);
  const r = parseDecimal(ratePercent);
  if (!a || !r) return null;
  return render(toCents(signed(a) * signed(r), a.scale + r.scale + 2), 2);
}

/** `a` − `b` − `c` → stringa a 2 decimali. null su input non validi. */
export function subtract(a, b, c = "0") {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const pc = parseDecimal(c);
  if (!pa || !pb || !pc) return null;
  const scale = Math.max(pa.scale, pb.scale, pc.scale);
  const lift = (p) => signed(p) * 10n ** BigInt(scale - p.scale);
  return render(toCents(lift(pa) - lift(pb) - lift(pc), scale), 2);
}

const isNegative = (value) => String(value ?? "").trim().startsWith("-");

// ---------------------------------------------------------------------------
// Aliquote suggerite
// ---------------------------------------------------------------------------

const RATE_GOVT = "12.5";
const RATE_OTHER = "26";

// Titoli di Stato ed equiparati: 12,5%. Tutto il resto: 26%. Il riconoscimento è
// un SUGGERIMENTO — il payload del calendario non porta l'emittente, quindi si
// deduce dal nome e dall'ISIN e resta modificabile con un click.
const GOVT_NAME = /\b(btp|bot|cct|ctz|bund|oat|bono|gilt|treasury|obbligazioni? di stato|titol[oi] di stato)\b/i;

function looksGovernment(instrument) {
  if (!instrument) return false;
  const name = String(instrument.name || "");
  if (GOVT_NAME.test(name)) return true;
  return /italia/i.test(name) && /\bbtp\b/i.test(name);
}

const KIND_TITLES = {
  COUPON: "Conferma la cedola incassata",
  DIVIDEND: "Conferma il dividendo incassato",
  REDEMPTION: "Rimborso a scadenza",
};

// ---------------------------------------------------------------------------

export default function ConfirmEventDialog({ event, portfolioId, onClose }: ConfirmEventDialogProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const cardRef = useRef(null);
  const firstFieldRef = useRef(null);

  const suggestedRate = looksGovernment(event?.instrument) ? RATE_GOVT : RATE_OTHER;

  const [tradeDate, setTradeDate] = useState(event?.payDate ?? "");
  const [gross, setGross] = useState(event?.estimatedGross ?? "");
  const [rate, setRate] = useState(suggestedRate);
  const [taxes, setTaxes] = useState(() => percentOf(event?.estimatedGross ?? "0", suggestedRate) ?? "0");
  const [fees, setFees] = useState("0");
  const [note, setNote] = useState("");
  const [serverError, setServerError] = useState(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /** Cambiando aliquota (o lordo) la ritenuta si ricalcola, ma resta editabile. */
  const applyRate = (nextRate, nextGross = gross) => {
    setRate(nextRate);
    if (nextRate === "custom") return;
    const computed = percentOf(nextGross, nextRate);
    if (computed !== null) setTaxes(computed);
  };

  const net = useMemo(() => subtract(gross || "0", taxes || "0", fees || "0"), [gross, taxes, fees]);
  const netIsNegative = isNegative(net);

  const mutation = useMutation({
    mutationFn: (body) => post(`/calendar/${event.id}/confirm`, body),
    onSuccess: () => {
      // Il movimento appena creato cambia posizioni, KPI, rendimenti, elenco
      // movimenti e stato dell'evento: si invalidano i tre prefissi interi
      // invece di indovinare le chiavi esatte.
      queryClient.invalidateQueries({ queryKey: ["calendar"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      toast.success("Incasso registrato: il movimento è stato creato.");
      onClose();
    },
    onError: (error) => setServerError(error),
  });

  const submit = (e) => {
    e.preventDefault();
    setServerError(null);
    mutation.mutate({
      portfolioId: portfolioId || undefined,
      tradeDate: tradeDate || undefined,
      grossAmount: gross === "" ? null : gross,
      taxes: taxes === "" ? "0" : taxes,
      fees: fees === "" ? "0" : fees,
      note: note || undefined,
    });
  };

  if (!event) return null;

  const isRedemption = event.kind === "REDEMPTION";
  const conflict = serverError?.status === 409;
  const hint = serverError?.details?.hint;

  return (
    <div
      className="pt-dialog-backdrop"
      // Il click fuori chiude; il mousedown sulla card non deve propagare.
      onMouseDown={(e) => {
        if (!cardRef.current?.contains(e.target)) onClose();
      }}
    >
      <div
        className="pt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pt-confirm-title"
        ref={cardRef}
      >
        <h2 id="pt-confirm-title">{KIND_TITLES[event.kind] || "Conferma l'evento"}</h2>

        <div className="pt-dialog-summary">
          <div>
            <strong>{event.instrument?.name}</strong>
            {event.instrument?.isin ? ` · ${event.instrument.isin}` : null}
          </div>
          <div className="muted small">
            Pagamento previsto il {date(event.payDate)}
            {event.quantityAtDate ? ` · ${qty(event.quantityAtDate)} in portafoglio` : null}
          </div>
          <div className="muted small">
            {event.amountPerUnit == null
              ? "Importo per unità non dichiarato dalla fonte."
              : `${num(event.amountPerUnit, 4)} ${event.currency} ${
                  event.amountUnit === "per_100_nominale"
                    ? "per 100 di nominale"
                    : "per azione"
                }`}
            {event.estimatedGross
              ? ` → lordo stimato ${money(event.estimatedGross, event.currency)}`
              : null}
          </div>
        </div>

        {isRedemption ? (
          <div className="warnings" role="status">
            Un rimborso a scadenza è capitale che rientra, non un reddito: va registrato come
            vendita al 100 del nominale, così chiude la posizione e realizza la differenza
            rispetto al carico.
          </div>
        ) : null}

        {serverError ? (
          <div className="form-error" role="alert">
            <div>{serverError.message}</div>
            {conflict && serverError.details?.transactionId ? (
              <div className="small">
                Movimento già collegato: #{serverError.details.transactionId}. Ricarica la pagina
                per vederlo.
              </div>
            ) : null}
            {hint ? <div className="small">Come procedere: {hint}</div> : null}
          </div>
        ) : null}

        <form onSubmit={submit}>
          <label className="field">
            <span className="field-label">Data del movimento</span>
            <input
              ref={firstFieldRef}
              className="input"
              type="date"
              value={tradeDate}
              onChange={(e) => setTradeDate(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field-label">
              Importo lordo ({event.currency}) — precompilato dallo scadenzario
            </span>
            <input
              className="input"
              type="text"
              inputMode="decimal"
              value={gross}
              onChange={(e) => {
                setGross(e.target.value);
                if (rate !== "custom") applyRate(rate, e.target.value);
              }}
            />
          </label>

          <fieldset style={{ border: 0, padding: 0, margin: "0 0 var(--gap)" }}>
            <legend className="field-label">Ritenuta suggerita</legend>
            <label className="pt-radio">
              <input
                type="radio"
                name="pt-rate"
                checked={rate === RATE_GOVT}
                onChange={() => applyRate(RATE_GOVT)}
              />
              <span>12,5 % — titoli di Stato ed equiparati</span>
            </label>
            <label className="pt-radio">
              <input
                type="radio"
                name="pt-rate"
                checked={rate === RATE_OTHER}
                onChange={() => applyRate(RATE_OTHER)}
              />
              <span>26 % — azioni, ETF, obbligazioni societarie</span>
            </label>
            <label className="pt-radio">
              <input
                type="radio"
                name="pt-rate"
                checked={rate === "custom"}
                onChange={() => setRate("custom")}
              />
              <span>Importo personalizzato</span>
            </label>
            <p className="pt-hint">
              È un suggerimento: l'aliquota effettiva la scrive l'estratto conto del broker, e
              l'importo qui sotto resta modificabile.
            </p>
          </fieldset>

          <label className="field">
            <span className="field-label">Ritenuta ({event.currency})</span>
            <input
              className="input"
              type="text"
              inputMode="decimal"
              value={taxes}
              onChange={(e) => {
                setTaxes(e.target.value);
                setRate("custom");
              }}
            />
          </label>

          <label className="field">
            <span className="field-label">Commissioni ({event.currency})</span>
            <input
              className="input"
              type="text"
              inputMode="decimal"
              value={fees}
              onChange={(e) => setFees(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field-label">Nota (facoltativa)</span>
            <input
              className="input"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={`Confermato dal calendario (evento #${event.id})`}
            />
          </label>

          <div className="pt-dialog-summary">
            {/* Lordo, ritenuta e netto restano tre voci: il netto è mostrato, non
                sostituisce le altre due. */}
            <div className="pt-dialog-net">
              <span>Netto accreditato</span>
              <span>{net === null ? "—" : money(net, event.currency)}</span>
            </div>
            {netIsNegative ? (
              <p className="pt-hint">
                Ritenuta e commissioni superano il lordo: il server rifiuterà il movimento.
              </p>
            ) : null}
          </div>

          <div className="pt-dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Annulla
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={mutation.isPending || netIsNegative || net === null}
            >
              {mutation.isPending ? "Registro…" : "Conferma e registra"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
