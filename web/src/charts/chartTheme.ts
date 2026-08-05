// Tema dei grafici. UNICO posto dove vivono i colori delle serie.
//
// Nessun componente deve hardcodare un hex: si chiede sempre un RUOLO
// (`series(0)`, `theme.grid`, `theme.textMuted`). Così la modalità scura è un
// secondo set di step SELEZIONATO, non un flip automatico dei colori chiari.
//
// ─────────────────────────────────────────────────────────────────────────────
// PALETTE VALIDATA — non modificare i valori senza rieseguire il validator.
//
//   node scripts/validate_palette.js "<hex,…>" --mode light [--pairs all]
//   node scripts/validate_palette.js "<hex,…>" --mode dark  [--pairs all]
//
// Esiti registrati (agosto 2026):
//
//   3 slot, --pairs all, light : TUTTI E SEI PASS. Peggior CVD ΔE 9,2 (deutan),
//                                peggior visione normale ΔE 24,0.
//                                WARN contrasto: aqua #1baf7a a 2,74:1.
//   3 slot, --pairs all, dark  : TUTTI E SEI PASS, nessun WARN.
//   8 slot, adiacenti, light   : PASS. Peggior CVD ΔE 9,1 (protan), normale 19,6.
//                                WARN contrasto su aqua, giallo, magenta.
//   8 slot, adiacenti, dark    : PASS, nessun WARN.
//
// Il WARN di contrasto in chiaro ATTIVA LA REGOLA DI RIMEDIO della skill:
// etichette dirette visibili oppure vista tabellare OBBLIGATORIE. Non è
// ignorabile. Nell'app entrambe sono presenti: `AllocationBar` etichetta i
// segmenti direttamente e la tabella posizioni è sempre in pagina.
//
// Il pairlist ADIACENTE (non `--pairs all`) è quello corretto per barre in stack e
// colonne, dove solo i vicini si toccano. Le forme all-pairs (scatter, bolle)
// avrebbero un cap di 3 slot — non ne usiamo.
// ─────────────────────────────────────────────────────────────────────────────

/** Le due modalità: un secondo set di step SELEZIONATO, non un flip dei colori chiari. */
export type ChartMode = "light" | "dark";

/** Slot categorici, in ordine FISSO. Mai ciclati, mai generati. */
export const CATEGORICAL: Record<ChartMode, string[]> = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

/** Contrasto misurato sulla superficie chiara: sotto 3:1 serve il rimedio. */
const LOW_CONTRAST_LIGHT = new Set(["#1baf7a", "#eda100", "#e87ba4"]);

/** I token di cornice: superficie, testo, griglia, e i due toni con segno. */
export interface ChartChrome {
  surface: string;
  plane: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  grid: string;
  axis: string;
  border: string;
  positive: string;
  negative: string;
}

export const CHROME: Record<ChartMode, ChartChrome> = {
  light: {
    surface: "#fcfcfb",
    plane: "#f9f9f7",
    textPrimary: "#0b0b0b",
    textSecondary: "#52514e",
    textMuted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    border: "rgba(11,11,11,0.10)",
    positive: "#006300",
    negative: "#d03b3b",
  },
  dark: {
    surface: "#1a1a19",
    plane: "#0d0d0d",
    textPrimary: "#ffffff",
    textSecondary: "#c3c2b7",
    textMuted: "#898781",
    grid: "#2c2c2a",
    axis: "#383835",
    border: "rgba(255,255,255,0.10)",
    positive: "#0ca30c",
    negative: "#d03b3b",
  },
};

/** Stati: riservati, mai riusati come "serie 4". Vanno sempre con icona + etichetta. */
export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
};

/**
 * Specifiche delle marche, dalla skill. Numeri, non opinioni.
 *
 * `as const` perché `lineCap` finisce in `strokeLinecap`, che vuole il letterale
 * "round" e non un `string` qualsiasi.
 */
export const MARKS = {
  lineWidth: 2,
  lineCap: "round",
  markerMinSize: 8,
  barMaxThickness: 24,
  barRadius: 4, // solo l'estremità dei dati, la base resta quadra
  segmentGap: 2, // gap di superficie tra segmenti adiacenti
  gridWidth: 1,
} as const;

export function detectMode(): ChartMode {
  if (typeof document === "undefined") return "light";
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark" || explicit === "light") return explicit;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

/** Tema per la modalità corrente. */
export function getChartTheme(mode: ChartMode = detectMode()) {
  const m = mode === "dark" ? "dark" : "light";
  const palette = CATEGORICAL[m];
  const chrome = CHROME[m];

  return {
    mode: m,
    ...chrome,
    status: STATUS,
    marks: MARKS,

    /**
     * Colore della serie per indice, in ordine fisso.
     *
     * Oltre l'ottavo slot NON si genera una nona tinta: si ripiega in "Altro" o si
     * sfaccetta (la API già accorpa la coda). Se arriva un indice fuori range è un
     * bug del chiamante, e restituire il colore muted lo rende visibile invece di
     * nasconderlo dietro un ciclo.
     */
    series(i: number): string {
      const idx = Number(i);
      if (!Number.isInteger(idx) || idx < 0 || idx >= palette.length) return chrome.textMuted;
      return palette[idx];
    },

    seriesCount: palette.length,

    /**
     * true se quel colore ha meno di 3:1 sulla superficie: il chiamante DEVE
     * fornire etichetta diretta o vista tabellare (regola di rimedio della skill).
     */
    needsRelief(hex: string): boolean {
      return m === "light" && LOW_CONTRAST_LIGHT.has(String(hex).toLowerCase());
    },

    /** Tinta sequenziale singola: per la GRANDEZZA, non per l'identità. */
    sequential: m === "dark" ? "#3987e5" : "#2a78d6",

    /** Tono per un delta con segno. Il testo resta sempre in token di TESTO. */
    tone(sign: number | null): string {
      if (sign === null) return chrome.textMuted;
      if (sign > 0) return chrome.positive;
      if (sign < 0) return chrome.negative;
      return chrome.textMuted;
    },
  };
}

/**
 * Il tema come lo vedono i componenti. Derivato dalla funzione invece di
 * dichiarato a parte: un ruolo aggiunto a `getChartTheme` è subito disponibile,
 * senza una seconda lista da tenere allineata.
 */
export type ChartTheme = ReturnType<typeof getChartTheme>;

/**
 * Props di un pattern SVG a righe 45°, il canale TEXTURE della skill.
 *
 * Serve a distinguere PROIETTATO da CONFERMATO nel grafico dei redditi: è
 * esattamente il caso motivato dall'accessibilità per cui la texture è riservata.
 * Una seconda tinta sarebbe sbagliata, perché la distinzione non è di identità ma di
 * CERTEZZA del dato — e una seconda tinta implicherebbe una seconda categoria.
 *
 * Tono su tono: le righe sono dello stesso colore della campitura, che resta
 * l'unica tinta del grafico.
 *
 * Uso:
 *   const h = hatch45("proiettato", theme.sequential);
 *   <defs><pattern {...h.patternProps}><path {...h.pathProps} /></pattern></defs>
 *   <Bar fill={h.fill} />
 */
export function hatch45(
  id: string,
  color: string,
  { spacing = 6, strokeWidth = 2 }: { spacing?: number; strokeWidth?: number } = {}
) {
  return {
    id,
    fill: `url(#${id})`,
    patternProps: {
      id,
      patternUnits: "userSpaceOnUse",
      width: spacing,
      height: spacing,
      patternTransform: "rotate(45)",
    },
    // Righe piene su fondo trasparente: il colore della serie resta riconoscibile
    // ma la campitura è visibilmente diversa anche in bianco e nero.
    pathProps: {
      d: `M 0,-1 L 0,${spacing + 1}`,
      stroke: color,
      strokeWidth,
      opacity: 0.85,
    },
    backgroundProps: { width: spacing, height: spacing, fill: color, opacity: 0.18 },
  };
}
