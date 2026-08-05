import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patch, post, fieldErrorsOf, toFormError } from "../api";
import { Field } from "./Money";
import Spinner from "./Spinner";
import type { FormEvent } from "react";
import type { FieldIssue, FormError } from "../api";
import type { Portfolio } from "../types";

interface PortfolioFormProps {
  /** null (o assente) = creazione. */
  portfolio?: Portfolio | null;
  onSaved?: (saved: Portfolio) => void;
  onCancel?: () => void;
}

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "SEK", "DKK", "NOK", "CAD", "AUD"];

interface FormState {
  name: string;
  baseCcy: string;
  broker: string;
}

interface PortfolioPayload {
  name: string;
  baseCcy: string;
  broker: string | null;
}

const EMPTY: FormState = { name: "", baseCcy: "EUR", broker: "" };

function formFromPortfolio(p: Portfolio | null | undefined): FormState {
  if (!p) return { ...EMPTY };
  return { name: p.name || "", baseCcy: p.baseCcy || "EUR", broker: p.broker || "" };
}

export default function PortfolioForm({ portfolio = null, onSaved, onCancel }: PortfolioFormProps) {
  const editing = Boolean(portfolio?.id);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => formFromPortfolio(portfolio));
  const [error, setError] = useState<FormError | null>(null);

  const set = (patchObj: Partial<FormState>) => setForm((f) => ({ ...f, ...patchObj }));

  const payload = useMemo<PortfolioPayload>(
    () => ({
      name: form.name.trim(),
      baseCcy: form.baseCcy,
      broker: form.broker.trim() || null,
    }),
    [form]
  );

  const save = useMutation({
    mutationFn: (bodyObj: PortfolioPayload) =>
      portfolio
        ? patch<Portfolio>(`/portfolios/${portfolio.id}`, bodyObj)
        : post<Portfolio>("/portfolios", bodyObj),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["portfolios"] });
      onSaved?.(saved);
    },
    onError: (err) => setError(toFormError(err)),
  });

  const fieldErrors = useMemo(() => fieldErrorsOf(error), [error]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    save.mutate(payload);
  };

  // `details` porta il portafoglio che esiste già solo per un conflict; per un
  // validation_error è l'elenco dei campi.
  const conflict =
    error?.code === "conflict" ? (error.details as { name?: string } | null) : null;
  const issues: FieldIssue[] = Array.isArray(error?.details) ? (error.details as FieldIssue[]) : [];

  return (
    <form className="tx-form" onSubmit={onSubmit} noValidate>
      {error ? (
        <div className="form-error" role="alert">
          {error.message}
          {conflict?.name ? <p className="small">Esiste già: {conflict.name}.</p> : null}
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
        <Field label="Nome" required error={fieldErrors.name} wide>
          <input
            className="input"
            type="text"
            maxLength={120}
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>

        <Field label="Valuta base" required error={fieldErrors.baseCcy}>
          <select
            className="select"
            value={form.baseCcy}
            onChange={(e) => set({ baseCcy: e.target.value })}
          >
            {[...new Set([...CURRENCIES, form.baseCcy])].sort().map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Broker" error={fieldErrors.broker}>
          <input
            className="input"
            type="text"
            maxLength={120}
            value={form.broker}
            onChange={(e) => set({ broker: e.target.value })}
          />
        </Field>
      </div>

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
            "Crea portafoglio"
          )}
        </button>
      </div>
    </form>
  );
}
