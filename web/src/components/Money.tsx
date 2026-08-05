import { money, signedMoney, toneOf, DASH } from "../format";
import type { ReactNode } from "react";

interface MoneyProps {
  value: string | null;
  ccy?: string;
  withSign?: boolean;
  tone?: boolean;
  className: string;
}

interface FieldProps {
  label: ReactNode;
  hint: ReactNode;
  error: ReactNode;
  required?: boolean;
  children?: ReactNode;
  wide?: boolean;
}

interface DecimalInputProps {
  value: string | null;
  onChange?: (...args: any[]) => void;
  placeholder: string;
  disabled: boolean;
  readOnly: boolean;
  id: string;
  /** Attributi passati al nodo sottostante. */
  [key: string]: any;
}

interface ReadOnlyValueProps {
  children?: ReactNode;
  title: string;
}


/**
 * Importo monetario, con tono e segno opzionali.
 *
 * Il tono si sceglie con `toneOf` sulla stringa: nessun confronto numerico, quindi
 * nemmeno la decisione "verde o rosso" passa da un Number.
 */
export default function Money({ value, ccy = "EUR", withSign = false, tone = false, className }: MoneyProps) {
  const text = withSign ? signedMoney(value, ccy) : money(value, ccy);
  const classes = ["num", tone ? toneOf(value) : "", className].filter(Boolean).join(" ");
  return <span className={classes}>{text}</span>;
}

// --- Il lato "input" dello stesso contratto ---
//
// Il campo decimale vive accanto al formattatore perché sono i due versi della
// stessa regola: le stringhe decimali entrano ed escono dall'app senza mai
// passare da un Number (docs/decisions.md §1). Tenerli insieme rende difficile
// introdurre per distrazione un campo numerico nativo: qui non ce n'è nemmeno uno.

/** Etichetta + campo + errore/aiuto, la forma usata da tutti i form. */
export function Field({ label, hint, error, required = false, children, wide = false }: FieldProps) {
  return (
    <label className={wide ? "field field--wide" : "field"}>
      <span className="field-label">
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

/**
 * Campo per importi, quantità, prezzi e tassi.
 *
 * Il tipo è sempre testo, MAI il campo numerico nativo: lo spinner arrotonda, la
 * rotellina del mouse modifica il valore per sbaglio, e soprattutto
 * `valueAsNumber` invita a leggere un double dove l'app vuole la stringa esatta
 * digitata. `inputMode="decimal"` dà comunque il tastierino numerico su mobile.
 */
export function DecimalInput({ value, onChange, placeholder, disabled, readOnly, id, ...rest }: DecimalInputProps) {
  return (
    <input
      id={id}
      className="input num"
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck="false"
      value={value ?? ""}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
}

/** Valore in sola lettura dentro un form (es. la quantità derivata dal nominale). */
export function ReadOnlyValue({ children, title }: ReadOnlyValueProps) {
  return (
    <span className="readonly-value num" title={title}>
      {children ?? DASH}
    </span>
  );
}

/**
 * Normalizza ciò che l'utente digita nella forma che il server valida
 * (`/^-?\d{1,20}(\.\d{1,12})?$/`): virgola italiana → punto, spazi via,
 * ",5" → "0.5". È una riscrittura di caratteri, non una conversione numerica.
 * @returns {string|null} null se il campo è vuoto.
 */
export function toDecimal(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/\s/g, "").replace(",", ".");
  if (s === "" || s === "-") return null;
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith(".")) s = `0${s}`;
  if (s.startsWith("-.")) s = `-0${s.slice(1)}`;
  return s;
}
