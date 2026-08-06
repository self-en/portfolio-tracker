// Prompt e schema dell'output dell'analisi. FUNZIONI PURE: nessuna chiamata di
// rete, nessun I/O, niente `Date.now()` — così i prompt sono verificabili da un
// unit test invece di essere leggibili solo guardando una risposta a pagamento.
//
// Tre scelte da capire prima di modificare questo file:
//
//  1. **Il prompt di sistema NON contiene i dati dello strumento.** I dati vivono
//     nel turno utente. È ciò che rende il prefisso stabile e quindi memorizzabile
//     nella cache dei prompt: analizzare venti azioni riscrive il prefisso una volta
//     sola invece di venti. Mettere il nome del titolo nel prompt di sistema
//     invaliderebbe la cache a ogni analisi, in silenzio.
//  2. **Il blocco per classe di attivo è appeso al prompt di sistema**, non
//     interpolato in mezzo: la cache è un prefisso, quindi le classi diventano
//     cinque prefissi distinti (uno per classe) invece di uno inutilizzabile.
//  3. **L'output è vincolato da uno schema JSON** (structured outputs), non chiesto
//     "in JSON per favore": un campo mancante diventerebbe un `undefined` in
//     database e una scheda mezza vuota in pagina.
import type { RiskMetrics } from "../domain/riskMetrics";
import type { NormalizedFundamentals } from "../market/yahooProvider";
import type { AnalysisConfidence, AnalysisVerdict, DateString } from "../types";

/**
 * Tutto ciò che il modello vede. Assemblato dal layer HTTP (`routes/analysis.ts`),
 * che è l'unico a poter leggere database e provider.
 *
 * I numerici sono STRINGHE, già serializzate come nel resto dell'API: il modello
 * legge gli stessi valori che l'utente vede in pagina, e non c'è un secondo
 * percorso di arrotondamento da tenere allineato.
 */
export interface AnalysisContext {
  /** Istante ISO dell'analisi: il modello non sa che giorno è, glielo diciamo noi. */
  generatedAt: string;
  /** Valuta di riferimento del portafoglio (EUR). */
  baseCcy: string;
  instrument: {
    id: number;
    name: string;
    assetClass: string;
    ticker: string | null;
    isin: string | null;
    exchange: string | null;
    currency: string;
    priceSource: string | null;
    quoteConvention: string | null;
    issuer: string | null;
    notes: string | null;
    active: boolean;
  };
  bond: {
    faceValue: string | null;
    couponRate: string | null;
    couponFrequency: number | null;
    firstCouponDate: DateString | null;
    maturityDate: DateString | null;
    dayCount: string | null;
  } | null;
  /** Le prossime cedole dallo scadenzario calcolato (non dal provider). */
  couponSchedule: Array<{ payDate: DateString; amountPer100: string; irregular: boolean }> | null;
  /** Cedola annua ÷ corso secco. NON è il rendimento a scadenza: l'app non lo calcola. */
  currentYield: string | null;
  quote: {
    price: string | null;
    currency: string | null;
    previousClose: string | null;
    asOf: string | null;
    marketState: string | null;
    source: string | null;
  } | null;
  priceCoverage: { from: DateString | null; to: DateString | null; rows: number };
  risk: RiskMetrics | null;
  fundamentals: NormalizedFundamentals | null;
  /** La posizione in portafoglio, nella stessa forma di GET /api/portfolio/positions. */
  position: Record<string, unknown> | null;
  /** In quale portafoglio è stata letta la posizione (l'app ne ammette più di uno). */
  portfolio: { id: number; name: string } | null;
  /** Valore totale del portafoglio, per dare senso al peso della posizione. */
  portfolioValue: string | null;
  /** Nome del provider di mercato: `manual` significa "nessun dato esterno". */
  provider: string;
}

const VERDICTS: AnalysisVerdict[] = ["COMPRARE", "MANTENERE", "RIDURRE", "EVITARE", "APPROFONDIRE"];
const CONFIDENCES: AnalysisConfidence[] = ["ALTA", "MEDIA", "BASSA"];
const SEVERITIES = ["ALTA", "MEDIA", "BASSA"];
const VALUATIONS = ["CARA", "EQUA", "ECONOMICA", "NON_VALUTABILE"];

/**
 * Lo schema dell'output strutturato.
 *
 * DUE LIMITI DELLO SCHEMA (non dimenticarli aggiungendo campi): i vincoli numerici
 * (`minimum`/`maximum`) e quelli sulle stringhe (`minLength`) NON sono supportati —
 * per questo il punteggio di solidità è un `enum` di interi e non un intervallo. E
 * ogni oggetto vuole `additionalProperties: false` più l'elenco completo in
 * `required`.
 */
const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "headline",
    "verdict",
    "confidence",
    "summary",
    "financialHealth",
    "valuation",
    "strengths",
    "risks",
    "positionAdvice",
    "watchlist",
    "dataGaps",
  ],
  properties: {
    headline: {
      type: "string",
      description: "Una sola frase, max 140 caratteri: la conclusione, non un titolo generico.",
    },
    verdict: { type: "string", enum: VERDICTS },
    confidence: { type: "string", enum: CONFIDENCES },
    summary: {
      type: "string",
      description: "Da tre a sei frasi: perché il verdetto è quello, citando i numeri decisivi.",
    },
    financialHealth: {
      type: "object",
      additionalProperties: false,
      required: ["score", "label", "notes"],
      properties: {
        score: {
          type: "integer",
          enum: [1, 2, 3, 4, 5],
          description: "1 = fragile, 3 = adeguata, 5 = solida. 3 anche quando i dati non bastano.",
        },
        label: { type: "string", description: "Due o tre parole, es. 'solida ma indebitata'." },
        notes: {
          type: "array",
          items: { type: "string" },
          description:
            "Da due a cinque osservazioni di BILANCIO, ognuna con il numero da cui nasce.",
        },
      },
    },
    valuation: {
      type: "object",
      additionalProperties: false,
      required: ["assessment", "notes"],
      properties: {
        assessment: { type: "string", enum: VALUATIONS },
        notes: { type: "array", items: { type: "string" } },
      },
    },
    strengths: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail"],
        properties: { title: { type: "string" }, detail: { type: "string" } },
      },
    },
    risks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "severity"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          severity: { type: "string", enum: SEVERITIES },
        },
      },
    },
    positionAdvice: {
      type: "string",
      description:
        "Cosa implica per QUESTA posizione (o per un primo acquisto se non c'è): dimensione, peso, tempi.",
    },
    watchlist: {
      type: "array",
      items: { type: "string" },
      description: "Da due a cinque cose da verificare in futuro, ognuna osservabile.",
    },
    dataGaps: {
      type: "array",
      items: { type: "string" },
      description: "I dati che mancavano. Vuoto solo se non mancava nulla.",
    },
  },
} as const;

/**
 * Le regole valide per ogni classe di attivo. È la parte che sta in cache, quindi
 * riscriverla ha un costo: cambia i byte del prefisso e la prima analisi dopo la
 * modifica lo riscrive.
 */
const BASE_SYSTEM = `Sei un analista finanziario che prepara una SCHEDA DECISIONALE su un singolo strumento per un investitore privato italiano che gestisce da sé un portafoglio personale. Rispondi in italiano.

DATI
- Lavori ESCLUSIVAMENTE sui dati del messaggio dell'utente. Non hai accesso a internet e non conosci notizie successive: non citare eventi, trimestrali o prezzi che non sono nel contesto.
- Non inventare né stimare numeri assenti. Se un dato manca, mettilo in dataGaps e tieni conto della lacuna nella confidenza.
- Un campo \`null\` significa "non disponibile", non "zero".
- Se \`fundamentals.asOf\` è vecchio di più di sei mesi rispetto a \`generatedAt\`, dillo: un bilancio vecchio è un dato debole, non un dato mancante.

CONVENZIONI DEI NUMERI (leggerle male è il modo più facile di sbagliare l'analisi)
- Gli importi sono nella valuta indicata; \`fundamentals.currency\` è la valuta del BILANCIO e può differire da quella di quotazione.
- Rapporti e variazioni sono FRAZIONI, non percentuali: 0.0345 = 3,45%; -0.32 = -32%.
- ECCEZIONE: \`balance.debtToEquity\` arriva dal provider già in percentuale (78.4 = 78,4%).
- \`profitability.*\` e \`dividend.yield\` sono frazioni.
- \`bond.couponRate\` è una frazione ANNUA (0.0345 = 3,45%).
- Per gli strumenti con \`quoteConvention: "PCT_OF_NOMINAL"\` il prezzo è una percentuale del nominale (corso SECCO, rateo escluso), non un prezzo per quota.
- \`currentYield\` è cedola annua ÷ corso secco: NON è il rendimento a scadenza, e non devi presentarlo come tale né calcolarne uno tuo.
- \`risk.volatility\` è annualizzata; \`risk.maxDrawdown.depth\` è negativa.
- Nella posizione: \`avgCost\`, \`price\` e \`marketValue\` sono nella valuta dello strumento, mentre \`costBasis\`, \`marketValueBase\`, \`unrealizedPnl\` e \`realizedPnl\` sono in \`baseCcy\` (la valuta del portafoglio). \`weight\` è la quota sul valore totale del portafoglio, come frazione.
- \`realizedPnl\` (plusvalenze realizzate), \`incomeNet\` (cedole e dividendi netti) e \`unrealizedPnl\` (plusvalenza latente) sono TRE VOCI SEPARATE: non sommarle in un unico "profitto", perché il trattamento fiscale italiano le tratta in modo diverso.

COME RAGIONARE
1. Solidità (l'analisi di bilancio): indebitamento contro liquidità e flussi, ratio correnti, qualità dell'utile (flusso di cassa operativo e libero contro utile netto), redditività del capitale, margini, e il TREND su più esercizi — un margine in discesa da tre anni conta più del suo livello.
2. Valutazione: multipli, prezzo contro la fascia a 52 settimane, distanza dai massimi. I target degli analisti sono contesto, non verità: citali come opinione di mercato.
3. Rischi CONCRETI di questo strumento, non generici ("i mercati possono scendere" non è un rischio). Ognuno con la sua gravità.
4. La posizione già in portafoglio: quantità, costo medio, latente, peso. Un titolo buono che pesa il 40% è un problema di concentrazione; un titolo mediocre con una perdita latente non va tenuto solo per non realizzarla.
5. Verdetto e cosa monitorare, in modo che l'analisi resti utile fra sei mesi.

STILE
- Concreto e breve. Ogni giudizio poggia su un numero che compare nei dati.
- Niente disclaimer generici, niente ovvietà, niente elenchi di definizioni.
- Non promettere rendimenti, non fare previsioni di prezzo puntuali, non dare consulenza fiscale.
- Questa è un'analisi di dati, non una raccomandazione personalizzata: l'utente decide.
- Se i dati non bastano a un giudizio onesto, il verdetto è APPROFONDIRE con confidenza BASSA. È una risposta legittima, molto meglio di un verdetto inventato.`;

/** Il blocco che cambia per classe: cosa si può davvero analizzare. */
const BY_ASSET_CLASS: Record<string, string> = {
  EQUITY: `CLASSE: AZIONE
Fai l'analisi di bilancio piena. Ordine di importanza: sostenibilità del debito (debito totale contro liquidità, flusso di cassa libero e EBITDA), qualità dell'utile (il flusso operativo segue l'utile netto?), redditività (ROE e ROA, margini), crescita (serie \`yearly\` di ricavi e utili: livello E direzione), dividendo (payout e copertura con il flusso di cassa libero).
Se \`statements\` è vuoto o ha voci nulle non è un errore: il provider ha smesso di pubblicare lo stato patrimoniale dettagliato. Usa i rapporti in \`balance\` e \`profitability\` e dichiara in dataGaps che lo stato patrimoniale voce per voce non era disponibile.
Considera anche la concentrazione settoriale rispetto al resto del portafoglio, se il contesto la mostra.`,

  ETF: `CLASSE: ETF
Non esiste un bilancio d'impresa da analizzare, e dirlo è parte della risposta. Al suo posto analizza: costo corrente (\`fund.expenseRatio\`, che è una frazione: 0.002 = 0,20% annuo) e quanto pesa sul rendimento atteso di lungo periodo; dimensione del fondo e forma legale (rischio di chiusura o di fusione); concentrazione (le prime posizioni e i pesi settoriali: un indice "globale" con il 25% in cinque titoli non è diversificato come sembra); esposizione valutaria contro la valuta di riferimento del portafoglio; rotazione del portafoglio.
La domanda utile per un ETF è "che ruolo ha nel portafoglio e a che costo", non "è sottovalutato". Il punteggio di solidità misura la qualità dello strumento (costo, dimensione, replica), non un bilancio.`,

  FUND: `CLASSE: FONDO
Come per un ETF: costi correnti, dimensione, forma legale, composizione e concentrazione, esposizione valutaria. Aggiungi il confronto implicito con l'alternativa a gestione passiva: un costo annuo alto va giustificato da qualcosa che si vede nei dati.`,

  BOND: `CLASSE: OBBLIGAZIONE
Qui il "bilancio" da leggere è lo SCADENZARIO, e i dati di mercato mancano per costruzione (il provider non copre i titoli di Stato: il prezzo è inserito a mano). Non trattare i campi assenti come un problema dello strumento.
Analizza: cedola e frequenza, scadenza e quindi la sensibilità ai tassi (più lontana la scadenza, più il prezzo si muove per ogni variazione dei rendimenti — ragiona qualitativamente, non calcolare una duration che i dati non permettono), corso secco rispetto a 100 (sopra la pari significa che le cedole future scontano un capitale che a scadenza rimborsa 100), rendimento corrente contro la cedola nominale, rischio dell'emittente, rischio di reinvestimento delle cedole, potere d'acquisto se l'obbligazione non è indicizzata, liquidità.
Se il prezzo in archivio è vecchio, dillo: su un titolo a pricing manuale la valorizzazione vale quanto l'ultimo inserimento.
La domanda utile è "tenere a scadenza o vendere", non "quanto salirà".`,

  CRYPTO: `CLASSE: CRIPTOATTIVITÀ
Non c'è un bilancio, non ci sono flussi di cassa, e non esiste un valore intrinseco calcolabile con questi dati: dichiaralo. Puoi analizzare solo prezzo, volatilità, drawdown e peso in portafoglio. Il punteggio di solidità riflette questa assenza di fondamentali: non superare 3 e spiega perché.`,

  CASH: `CLASSE: LIQUIDITÀ
Non c'è nulla da analizzare in termini di bilancio. Limitati al ruolo in portafoglio (riserva, potere d'acquisto, erosione da inflazione) e resta breve. Verdetto tipico: MANTENERE o APPROFONDIRE.`,
};

const FALLBACK_CLASS = `CLASSE: NON CLASSIFICATA
La classe di attivo non è tra quelle previste. Analizza ciò che i dati permettono, dichiara in dataGaps cosa non era determinabile e resta prudente sul verdetto.`;

/** Il prompt di sistema per una classe. Prefisso stabile + blocco della classe. */
function buildSystemPrompt(assetClass: string | null | undefined): string {
  const block = BY_ASSET_CLASS[String(assetClass || "").toUpperCase()] || FALLBACK_CLASS;
  return `${BASE_SYSTEM}\n\n${block}`;
}

/**
 * Il turno utente: una riga di istruzione e il contesto in JSON.
 *
 * JSON e non prosa: la forma è già quella dell'API, non c'è un secondo formato da
 * mantenere, e i `null` restano distinguibili da uno zero — cosa che una tabella in
 * testo perderebbe.
 */
function buildUserPrompt(context: AnalysisContext): string {
  const inst = context.instrument;
  const label = [inst.name, inst.ticker, inst.isin].filter(Boolean).join(" · ");
  return `Analizza questo strumento e compila la scheda: ${label}.

Contesto (JSON):
${JSON.stringify(context)}`;
}

/**
 * Riassunto dei dati mancanti, calcolato DA NOI sul contesto.
 *
 * Non è un doppione di `dataGaps` del modello: questo è il conto obiettivo di cosa
 * non è stato passato, e serve a due cose — mostrarlo in pagina senza fidarsi
 * dell'autodichiarazione del modello, e conservarlo nello snapshot.
 */
function contextGaps(context: AnalysisContext): string[] {
  const gaps: string[] = [];
  const f = context.fundamentals;
  if (!f) {
    gaps.push(
      context.provider === "manual"
        ? "nessun fondamentale: provider di mercato disattivato (MARKET_PROVIDER=manual)"
        : "nessun fondamentale disponibile dal provider per questo strumento"
    );
  } else {
    if (!f.profile) gaps.push("profilo dell'emittente (settore, industria, descrizione) assente");
    if (f.yearly.length === 0) gaps.push("serie storica di ricavi e utili assente");
    if (!f.balance.totalDebt && !f.balance.totalCash) gaps.push("indebitamento e liquidità assenti");
    if (f.statements.every((s) => !s.grossProfit && !s.operatingIncome)) {
      gaps.push("stato patrimoniale e conto economico voce per voce non pubblicati dal provider");
    }
  }
  if (!context.quote) gaps.push("nessuna quotazione corrente in archivio");
  if (context.priceCoverage.rows === 0) gaps.push("nessuno storico prezzi in archivio");
  else if (!context.risk?.volatility) gaps.push("storico prezzi troppo corto per volatilità e drawdown");
  if (!context.position) gaps.push("nessuna posizione in portafoglio su questo strumento");
  return gaps;
}

export {
  ANALYSIS_SCHEMA,
  BASE_SYSTEM,
  BY_ASSET_CLASS,
  VERDICTS,
  CONFIDENCES,
  SEVERITIES,
  VALUATIONS,
  buildSystemPrompt,
  buildUserPrompt,
  contextGaps,
};
