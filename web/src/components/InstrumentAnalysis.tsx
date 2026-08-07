// Analisi di bilancio dello strumento, generata con Claude.
//
// Tre cose che questo componente deve fare bene, perché sono ciò che distingue uno
// strumento di decisione da un generatore di testo:
//
//  1. **Dire su cosa si basa.** Prezzo, data del bilancio, presenza della posizione
//     e soprattutto i DATI MANCANTI stanno in pagina, non nei log. Un giudizio di cui
//     non si conosce la base non è verificabile, e su un'obbligazione o un ETF le
//     lacune sono la norma.
//  2. **Non fingere di essere veloce.** L'analisi dura decine di secondi: lo si
//     scrive prima di partire, invece di lasciare uno spinner muto che sembra rotto.
//  3. **Non fingere di essere un consiglio.** Il verdetto è un'etichetta su
//     un'analisi di dati, non una raccomandazione: il disclaimer arriva dal server ed
//     è sempre visibile.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, get, post } from "../api";
import { DASH, dateTime, num } from "../format";
import EmptyState from "./EmptyState";
import Spinner from "./Spinner";
import { useToast } from "./Toast";
import type { ReactNode } from "react";
import type {
  AnalysisCreatedResponse,
  AnalysisResponse,
  AnalysisVerdict,
  Instrument,
  InstrumentAnalysis as Analysis,
} from "../types";

/** Verdetto → classe del badge. I colori vengono dai token esistenti (--up/--down/…). */
const VERDICT_CLASS: Record<AnalysisVerdict, string> = {
  COMPRARE: "badge badge--verdict-buy",
  MANTENERE: "badge badge--verdict-hold",
  RIDURRE: "badge badge--verdict-trim",
  EVITARE: "badge badge--verdict-avoid",
  APPROFONDIRE: "badge badge--verdict-more",
};

const VERDICT_LABEL: Record<AnalysisVerdict, string> = {
  COMPRARE: "Comprare",
  MANTENERE: "Mantenere",
  RIDURRE: "Ridurre",
  EVITARE: "Evitare",
  APPROFONDIRE: "Approfondire",
};

const VALUATION_LABEL: Record<string, string> = {
  CARA: "valutazione tirata",
  EQUA: "valutazione allineata",
  ECONOMICA: "valutazione contenuta",
  NON_VALUTABILE: "non valutabile con questi dati",
};

const SEVERITY_CLASS: Record<string, string> = {
  ALTA: "badge badge--verdict-avoid",
  MEDIA: "badge badge--stale",
  BASSA: "badge",
};

/** Cosa può dire l'analisi per questa classe: si dichiara PRIMA di generarla. */
const CLASS_PITCH: Record<string, string> = {
  EQUITY:
    "Legge il bilancio (debito, liquidità, flussi di cassa, margini, redditività), la valutazione e i rischi, tenendo conto della tua posizione.",
  ETF: "Per un ETF non c'è un bilancio d'impresa: l'analisi guarda costo corrente, dimensione, concentrazione delle prime posizioni, settori e valuta.",
  FUND: "Per un fondo l'analisi guarda costi correnti, dimensione, composizione e concentrazione, confrontandoli con l'alternativa passiva.",
  BOND: "Per un'obbligazione l'analisi lavora sullo scadenzario: cedola, scadenza, sensibilità ai tassi, rischio emittente e reinvestimento. I dati di mercato non ci sono per costruzione.",
  CRYPTO:
    "Per una criptoattività non esistono fondamentali: l'analisi si limita a prezzo, volatilità, drawdown e peso in portafoglio, e lo dichiara.",
  CASH: "Sulla liquidità c'è poco da analizzare: ruolo in portafoglio ed erosione da inflazione.",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="analysis-block">
      <h3 className="analysis-block-title">{title}</h3>
      {children}
    </div>
  );
}

/** Il punteggio di solidità come cinque tacche: leggibile senza leggere un numero. */
function Score({ score }: { score: number }) {
  const safe = Number.isFinite(score) ? Math.min(Math.max(Math.round(score), 1), 5) : 3;
  return (
    <span className="analysis-score" title={`Solidità ${safe} su 5`}>
      <span className="sr-only">Solidità {safe} su 5</span>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= safe ? "analysis-pip analysis-pip--on" : "analysis-pip"} aria-hidden="true" />
      ))}
      <span className="num small muted">{safe}/5</span>
    </span>
  );
}

function AnalysisBody({ analysis, instrument }: { analysis: Analysis; instrument: Instrument }) {
  const a = analysis.analysis;
  const basis = analysis.basis;
  // Le lacune del server (obiettive) e quelle dichiarate dal modello si mostrano
  // insieme, senza ripetizioni: dicono la stessa cosa da due punti di vista.
  //
  // `Array.isArray` e non `?? []`: `analysis` e `context` sono JSONB e possono
  // arrivare da un dump importato senza nessuna validazione di forma (l'import
  // valida verdetto, confidenza e data — non il payload). Uno spread su un
  // non-array lancerebbe in render.
  const gaps = [
    ...new Set([
      ...(Array.isArray(basis?.gaps) ? basis.gaps : []),
      ...(Array.isArray(a?.dataGaps) ? a.dataGaps : []),
    ]),
  ];

  return (
    <>
      <div className="analysis-head">
        <span className={VERDICT_CLASS[analysis.verdict] || "badge"}>{VERDICT_LABEL[analysis.verdict] || analysis.verdict}</span>
        <span className="badge" title="Quanto il modello si fida dei dati che ha visto">
          confidenza {String(analysis.confidence ?? "").toLowerCase()}
        </span>
        <span className="muted small">{dateTime(analysis.createdAt)}</span>
      </div>

      <p className="analysis-headline">{a.headline}</p>
      <p>{a.summary}</p>

      <div className="grid grid--2">
        <Section title="Solidità di bilancio">
          <div className="row row--tight">
            <Score score={a.financialHealth?.score} />
            <span>{a.financialHealth?.label}</span>
          </div>
          <ul className="analysis-list">
            {(Array.isArray(a.financialHealth?.notes) ? a.financialHealth.notes : []).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Section>

        <Section title="Valutazione">
          <p className="analysis-assessment">
            {VALUATION_LABEL[a.valuation?.assessment] || a.valuation?.assessment || DASH}
          </p>
          <ul className="analysis-list">
            {(Array.isArray(a.valuation?.notes) ? a.valuation.notes : []).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Section>
      </div>

      <div className="grid grid--2">
        <Section title="Punti di forza">
          {Array.isArray(a.strengths) && a.strengths.length ? (
            <ul className="analysis-list">
              {a.strengths.map((s, i) => (
                <li key={i}>
                  <strong>{s.title}.</strong> {s.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nessuno rilevato dai dati disponibili.</p>
          )}
        </Section>

        <Section title="Rischi">
          {Array.isArray(a.risks) && a.risks.length ? (
            <ul className="analysis-list">
              {a.risks.map((r, i) => (
                <li key={i}>
                  <span className={SEVERITY_CLASS[r.severity] || "badge"}>
                    {String(r.severity ?? "").toLowerCase()}
                  </span>{" "}
                  <strong>{r.title}.</strong> {r.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nessuno rilevato dai dati disponibili.</p>
          )}
        </Section>
      </div>

      {a.positionAdvice ? (
        <Section title="Cosa implica per la tua posizione">
          <p>{a.positionAdvice}</p>
          {!basis?.hadPosition ? (
            <p className="muted small">
              Non risultano movimenti su questo strumento: il ragionamento riguarda un eventuale primo
              acquisto.
            </p>
          ) : null}
        </Section>
      ) : null}

      {Array.isArray(a.watchlist) && a.watchlist.length ? (
        <Section title="Da monitorare">
          <ul className="analysis-list">
            {a.watchlist.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* I dati mancanti NON sono una nota a piè di pagina: sono ciò che dice quanto
          vale il verdetto. Su bond ed ETF sono spesso la parte più informativa. */}
      {gaps.length ? (
        <div className="form-note form-note--warn">
          <strong>Dati non disponibili al momento dell'analisi.</strong>
          <ul className="analysis-list">
            {gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="muted small analysis-basis">
        {/* Su un bond il prezzo è una percentuale del nominale: mostrarlo nudo lo
            farebbe leggere come un prezzo per quota (docs/decisions.md §9). */}
        Basata su: prezzo{" "}
        {basis?.quotePrice
          ? instrument.quoteConvention === "PCT_OF_NOMINAL"
            ? `${num(basis.quotePrice, 4)} %`
            : num(basis.quotePrice, 4)
          : DASH}
        {basis?.quoteAsOf ? ` del ${dateTime(basis.quoteAsOf)}` : ""}
        {basis?.fundamentalsAsOf ? ` · bilancio al ${basis.fundamentalsAsOf}` : " · nessun bilancio dal provider"}
        {basis?.priceRows ? ` · ${basis.priceRows} rilevazioni di prezzo` : ""} · modello{" "}
        {analysis.servedBy || analysis.model}
        {analysis.effort ? ` (sforzo ${analysis.effort})` : ""}
        {analysis.usage?.inputTokens
          ? ` · ${analysis.usage.inputTokens} token in ingresso, ${analysis.usage.outputTokens ?? DASH} in uscita`
          : ""}
      </p>
    </>
  );
}

export default function InstrumentAnalysis({ instrument }: { instrument: Instrument }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = instrument.id;
  const queryKey = ["instruments", "analysis", id];

  const state = useQuery({
    queryKey,
    queryFn: ({ signal }) => get<AnalysisResponse>(`/instruments/${id}/analysis`, { signal }),
  });

  const run = useMutation<AnalysisCreatedResponse, ApiError>({
    mutationFn: () => post<AnalysisCreatedResponse>(`/instruments/${id}/analysis`),
    onSuccess: (created) => {
      // Si scrive direttamente la cache: la risposta della POST È l'analisi, e un
      // refetch farebbe aspettare per riottenere ciò che si ha già in mano.
      //
      // `prev` può essere `undefined`: un'analisi dura minuti, e se nel frattempo la
      // pagina è stata lasciata la query può essere stata raccolta dal garbage
      // collector di react-query. In quel caso l'updater NON deve restituire `prev`
      // (sarebbe un no-op silenzioso, con la scheda appena pagata che non compare):
      // si lascia decidere all'invalidate qui sotto, che rilegge dal server.
      queryClient.setQueryData<AnalysisResponse>(queryKey, (prev) =>
        prev
          ? {
              ...prev,
              latest: created.analysis,
              previous: prev.latest
                ? [
                    {
                      id: prev.latest.id,
                      createdAt: prev.latest.createdAt,
                      verdict: prev.latest.verdict,
                      confidence: prev.latest.confidence,
                      headline: prev.latest.headline,
                      model: prev.latest.model,
                    },
                    ...prev.previous,
                  ]
                : prev.previous,
            }
          : undefined
      );
      // Rete di sicurezza: se la cache era vuota (vedi sopra) questo la ricostruisce,
      // e in ogni caso riallinea `previous` al limite che applica il server.
      queryClient.invalidateQueries({ queryKey });
      // La lista degli strumenti mostra il verdetto: va rinfrescata.
      queryClient.invalidateQueries({ queryKey: ["instruments", "list"] });
      toast.success(`Analisi completata in ${Math.round(created.durationMs / 1000)} secondi.`);
    },
    onError: (e) => {
      if (e.code === "rate_limited") {
        toast.error(`Troppe analisi in poco tempo: riprova tra ${e.retryAfterSec ?? 60} secondi.`);
        return;
      }
      // Il server allega un `hint` pensato per l'utente (es. rate limit: "riprova
      // tra qualche minuto") oppure, sui 4xx, il messaggio grezzo dell'upstream:
      // mostrarlo evita di dover aprire i log per capire perché un pulsante non
      // ha funzionato. Il hint ha priorità perché è scritto per essere letto.
      const details = e.details as { hint?: string; upstream?: string } | null;
      const extra = details?.hint || details?.upstream;
      toast.error(`Analisi non completata: ${e.message}${extra ? ` — ${extra}` : ""}`);
    },
  });

  if (state.isPending) {
    return (
      <section className="card">
        <h2 className="card-title">Analisi con Claude</h2>
        <Spinner />
      </section>
    );
  }

  const data = state.data;
  const latest = data?.latest ?? null;
  const configured = !!data?.configured;
  const pitch =
    CLASS_PITCH[String(instrument.assetClass || "").toUpperCase()] ||
    "Legge i dati in archivio e prepara una scheda decisionale.";

  return (
    <section className="card" id="analisi">
      <div className="analysis-toolbar">
        <h2 className="card-title">Analisi con Claude</h2>
        <div className="row row--tight">
          {latest ? <span className="muted small">generata il {dateTime(latest.createdAt)}</span> : null}
          <button
            type="button"
            className={latest ? "btn" : "btn btn--primary"}
            onClick={() => run.mutate()}
            disabled={!configured || run.isPending}
            title={
              configured
                ? "Genera una nuova analisi: è una chiamata a pagamento e richiede fino a un minuto"
                : "Analisi non configurata su questo ambiente"
            }
          >
            {run.isPending ? <Spinner inline label="Analisi in corso…" /> : latest ? "Rigenera" : "Analizza con Claude"}
          </button>
        </div>
      </div>

      {state.error ? (
        <p className="form-note form-note--warn">
          Analisi non caricata: {(state.error as Error).message}{" "}
          <button type="button" className="btn btn--small" onClick={() => state.refetch()}>
            Riprova
          </button>
        </p>
      ) : null}

      {/* Non configurata: si spiega COSA impostare. Un pulsante spento senza motivo
          è il modo più rapido di far pensare che la funzione sia rotta.
          `data &&`: se la GET è FALLITA non sappiamo se il token c'è, e accusare la
          configurazione manderebbe l'utente a cercare un problema che non ha. */}
      {data && !configured ? (
        <div className="form-note form-note--warn">
          L'analisi con Claude non è configurata su questo ambiente: imposta{" "}
          <code>CLAUDE_CODE_OAUTH_TOKEN</code> dalla pagina Configurazione del progetto. Il resto
          dell'applicazione funziona normalmente.
        </div>
      ) : null}

      {run.isPending ? (
        <p className="form-note">
          Sto leggendo bilancio, storico prezzi e la tua posizione, poi ragiono sui dati: servono
          diverse decine di secondi. Puoi lasciare la pagina aperta.
        </p>
      ) : null}

      {latest ? (
        <AnalysisBody analysis={latest} instrument={instrument} />
      ) : (
        !run.isPending && configured && (
          <EmptyState
            title="Nessuna analisi per questo strumento"
            message={`${pitch} Ogni analisi è una chiamata a pagamento: si genera quando la chiedi, non automaticamente.`}
          />
        )
      )}

      {data?.previous?.length ? (
        <details className="analysis-history">
          <summary>Analisi precedenti ({data.previous.length})</summary>
          <ul className="analysis-list">
            {data.previous.map((p) => (
              <li key={p.id}>
                <span className="muted small num">{dateTime(p.createdAt)}</span>{" "}
                <span className={VERDICT_CLASS[p.verdict] || "badge"}>
                  {VERDICT_LABEL[p.verdict] || p.verdict}
                </span>{" "}
                {p.headline}
              </li>
            ))}
          </ul>
          <p className="muted small">
            Lo storico resta: confrontare due analisi a distanza di mesi dice come è cambiato il
            giudizio, ed è il motivo per cui non vengono sovrascritte.
          </p>
        </details>
      ) : null}

      {data?.disclaimer ? <p className="muted small">{data.disclaimer}</p> : null}
    </section>
  );
}

export { VERDICT_CLASS, VERDICT_LABEL };
