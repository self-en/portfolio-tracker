import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { put } from "../api.js";
import { date as fmtDate, num } from "../format.js";
import { useToast } from "./Toast.jsx";
import { DecimalInput, Field, toDecimal } from "./Money.jsx";
import Spinner from "./Spinner.jsx";
import { today } from "./RangePicker.jsx";

/**
 * Inserimento del prezzo di chiusura a mano.
 *
 * Per le obbligazioni è IL percorso normale, non un ripiego: la copertura del
 * provider sui titoli di Stato è zero (docs/decisions.md §9), quindi la serie
 * storica di un BTP esiste solo perché la si inserisce qui.
 */
export default function ManualPriceForm({ instrument, lastPrice = null }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [priceDate, setPriceDate] = useState(() => today());
  const [close, setClose] = useState("");
  const [error, setError] = useState(null);

  const isPct = instrument?.quoteConvention === "PCT_OF_NOMINAL";

  const save = useMutation({
    mutationFn: (bodyObj) => put(`/instruments/${instrument.id}/prices`, bodyObj),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["instruments"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      toast.success(`Prezzo del ${fmtDate(saved.date)} salvato: ${num(saved.close, 4)}.`);
      setClose("");
    },
    onError: (err) => setError(err),
  });

  const onSubmit = (e) => {
    e.preventDefault();
    setError(null);
    const value = toDecimal(close);
    if (!priceDate || value === null) {
      setError({ message: "Servono la data e il prezzo di chiusura." });
      return;
    }
    save.mutate({ date: priceDate, close: value });
  };

  const fieldErrors = Array.isArray(error?.details)
    ? Object.fromEntries(error.details.filter((d) => d.field).map((d) => [d.field, d.message]))
    : {};

  return (
    <form className="manual-price" onSubmit={onSubmit} noValidate>
      <h3 className="card-title">Aggiorna il prezzo a mano</h3>
      <p className="muted small">
        {isPct
          ? "Corso secco in percentuale del nominale, come lo pubblica il listino (es. 99,42). Il rateo viene calcolato a parte dallo scadenzario."
          : "Prezzo di chiusura nella valuta dello strumento."}
      </p>

      {error ? (
        <div className="form-error" role="alert">
          {error.message}
        </div>
      ) : null}

      <div className="form-grid">
        <Field label="Data" required error={fieldErrors.date}>
          <input
            className="input"
            type="date"
            value={priceDate}
            max={today()}
            onChange={(e) => setPriceDate(e.target.value)}
          />
        </Field>
        <Field
          label={isPct ? "Corso secco (% del nominale)" : `Chiusura (${instrument?.currency || "EUR"})`}
          required
          error={fieldErrors.close}
          hint={lastPrice ? `ultimo valore noto: ${num(lastPrice, 4)}` : undefined}
        >
          <DecimalInput value={close} onChange={setClose} placeholder={isPct ? "99,42" : "0,00"} />
        </Field>
      </div>

      <div className="row form-actions">
        <button type="submit" className="btn btn--primary" disabled={save.isPending}>
          {save.isPending ? <Spinner inline label="Salvataggio…" /> : "Salva prezzo"}
        </button>
      </div>
      <p className="muted small">
        Se la data inserita è la più recente disponibile, diventa anche la quotazione corrente
        usata dalla valorizzazione.
      </p>
    </form>
  );
}
