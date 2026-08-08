import { useId, useMemo, useRef } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { date as fmtDate, money, monthLabel, num } from "../format";
import ChartFrame from "./ChartFrame";
import ChartTooltip, { pointOf } from "./ChartTooltip";
import useChartTheme from "./useChartTheme";
import useElementWidth from "./useElementWidth";
import { AREA_FILL_OPACITY } from "./contrast";
import { compactTick, toNumber } from "./numbers";
import type { TooltipRenderProps, TooltipRow } from "./ChartTooltip";
import type { LegendItems } from "./ChartLegend";
import type { SeriesPoint, ValueSeriesResponse } from "../types";

interface ValueSeriesChartProps {
  points: SeriesPoint[];
  meta?: Partial<ValueSeriesResponse["meta"]>;
  refetching?: boolean;
}

/**
 * Un punto pronto per il disegno: i float per il pixel, `solid`/`dashed` per i
 * due tratti della stessa serie, e `raw` con le stringhe originali da formattare.
 */
interface PlotPoint {
  date: string;
  value: number | null;
  solid: number | null;
  dashed: number | null;
  netInvested: number | null;
  partial: boolean;
  raw: SeriesPoint;
}


// VALORE DEL PORTAFOGLIO NEL TEMPO — area a serie singola.
//
// Un solo asse y, sempre. Il rendimento percentuale NON entra qui: sta nel
// pannello dei rendimenti, sotto. Due scale sullo stesso riquadro inventerebbero
// una correlazione che nei dati non c'è, ed è il divieto numero uno.
//
// L'overlay dell'investito netto porta il conto a due serie, e da due serie in su
// la legenda è obbligatoria.
//
// I punti `partial` (prezzo o cambio mancante) si rendono TRATTEGGIATI e il badge
// dice quanti sono: uno zero silenzioso somiglia a un crollo del portafoglio, non
// a un buco nei dati, ed è la peggior modalità di fallimento dell'intera app.

const safe = (raw: string) => String(raw).replace(/[^a-zA-Z0-9_-]/g, "");

const DASH_PARTIAL = "3 3";
const DASH_INVESTED = "7 4";

/**
 * Un segmento è incerto se uno dei due estremi è parziale. Il tratto solido e
 * quello tratteggiato condividono i punti di confine, così la linea non si
 * spezza nel passaggio.
 */
function split(points: SeriesPoint[]): PlotPoint[] {
  const n = points.length;
  const partial = points.map((p) => !!p.partial);

  return points.map((p, i) => {
    const value = toNumber(p.value);
    const prevUncertain = i > 0 ? partial[i - 1] || partial[i] : null;
    const nextUncertain = i < n - 1 ? partial[i] || partial[i + 1] : null;

    const touchesSolid =
      n === 1 ? !partial[0] : prevUncertain === false || nextUncertain === false;
    const touchesDashed = prevUncertain === true || nextUncertain === true;

    return {
      date: p.date,
      value,
      solid: touchesSolid ? value : null,
      dashed: touchesDashed ? value : null,
      netInvested: toNumber(p.netInvested),
      partial: partial[i],
      // Le stringhe originali restano a bordo del punto: il tooltip formatta
      // quelle, non il float che serviva al pixel.
      raw: p,
    };
  });
}

export default function ValueSeriesChart({ points, meta, refetching = false }: ValueSeriesChartProps) {
  const theme = useChartTheme();
  const gradientId = `${safe(useId())}-value-fill`;

  // La larghezza REALE del plot, non un media query listener: useElementWidth la
  // osserva già con un ResizeObserver, e ciò che conta qui è quanto spazio ha il
  // disegno (un grafico dentro un drawer è stretto anche su schermo largo).
  // Con w === 0, primo render prima della misura, si usano i valori desktop: così
  // non c'è un salto di layout all'apertura.
  const plotRef = useRef<HTMLDivElement>(null);
  const plotWidth = useElementWidth(plotRef);
  const narrow = plotWidth > 0 && plotWidth < 480;

  const seriesColor = theme.series(0);
  const baseCcy = meta?.baseCcy || "EUR";
  const granularity = meta?.granularity || "day";
  const partialPoints = meta?.partialPoints ?? 0;

  const data = useMemo(() => split(points || []), [points]);
  const hasInvested = data.some((p) => p.netInvested !== null);

  const formatX = (value: string | number) =>
    granularity === "month" ? monthLabel(String(value).slice(0, 7)) : fmtDate(value);

  const legend: LegendItems = [
    { label: `Valore di mercato (${baseCcy})`, color: seriesColor, mark: "line" as const },
    hasInvested && {
      label: "Investito netto",
      color: theme.textMuted,
      mark: "line" as const,
      dash: DASH_INVESTED,
      note: "versamenti meno prelievi",
    },
    partialPoints > 0 && {
      label: "Tratto con dati incompleti",
      color: seriesColor,
      mark: "line" as const,
      dash: DASH_PARTIAL,
      note: "prezzo o cambio mancante",
    },
  ];

  const tooltip = (props: TooltipRenderProps) => {
    const point = pointOf<PlotPoint>(props);
    if (!point) return null;
    const rows: TooltipRow[] = [
      { label: "Valore", value: money(point.raw.value, baseCcy), color: seriesColor },
    ];
    if (point.netInvested !== null) {
      rows.push({
        label: "Investito netto",
        value: money(point.raw.netInvested, baseCcy),
        color: theme.textMuted,
        dash: DASH_INVESTED,
      });
    }
    return (
      <ChartTooltip
        title={formatX(point.date)}
        rows={rows}
        flag={point.partial ? "Dati incompleti a questa data: il contributo di alcuni strumenti è escluso, non azzerato." : null}
      />
    );
  };

  const table = (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Valore del portafoglio per data</caption>
        <thead>
          <tr>
            <th scope="col">Data</th>
            <th scope="col" className="num">Valore</th>
            <th scope="col" className="num">Investito netto</th>
            <th scope="col">Dati</th>
          </tr>
        </thead>
        <tbody>
          {/* data-label ripete l'intestazione: sotto i 640px la riga diventa una
              scheda e senza di esso resterebbe una colonna di numeri anonimi. */}
          {data.map((p) => (
            <tr key={p.date}>
              <td data-label="Data">{fmtDate(p.date)}</td>
              <td className="num" data-label="Valore">
                {money(p.raw.value, baseCcy)}
              </td>
              <td className="num" data-label="Investito netto">
                {money(p.raw.netInvested, baseCcy)}
              </td>
              <td data-label="Dati">{p.partial ? "incompleti" : "completi"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <ChartFrame
      title="Valore del portafoglio nel tempo"
      subtitle={`Importi in ${baseCcy}, granularità ${granularity === "month" ? "mensile" : granularity === "week" ? "settimanale" : "giornaliera"}`}
      legend={legend}
      refetching={refetching}
      badges={
        partialPoints > 0 ? (
          <span className="badge badge--stale">
            dati incompleti: {num(partialPoints, 0)} {partialPoints === 1 ? "punto" : "punti"}
          </span>
        ) : null
      }
      note={
        partialPoints > 0
          ? "Nei tratti tratteggiati manca il prezzo (o il cambio) di almeno uno strumento: il contributo è escluso, non azzerato. Non è un calo del portafoglio."
          : null
      }
      table={table}
    >
      <div ref={plotRef}>
        {/* 210px invece di 300: su un telefono in verticale un grafico da 300px si
            prende un terzo dello schermo prima che si veda il resto della pagina. */}
        <ResponsiveContainer width="100%" height={narrow ? 210 : 300}>
          <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={seriesColor} stopOpacity={AREA_FILL_OPACITY} />
                <stop offset="100%" stopColor={seriesColor} stopOpacity={0.01} />
              </linearGradient>
            </defs>

            {/* Griglia recessiva: hairline solida, un passo dalla superficie. */}
            <CartesianGrid
              stroke={theme.grid}
              strokeWidth={theme.marks.gridWidth}
              vertical={false}
            />
            <XAxis
              dataKey="date"
              tickFormatter={formatX}
              stroke={theme.axis}
              strokeWidth={theme.marks.gridWidth}
              tick={{ fill: theme.textMuted, fontSize: 11 }}
              tickLine={false}
              minTickGap={44}
              interval="preserveStartEnd"
            />
            {/* UN SOLO asse y, senza identificatore d'asse: non può nascerne un secondo. */}
            <YAxis
              domain={[0, "auto"]}
              // Su un plot stretto 58px d'asse sono il 18% della larghezza: si
              // scende a 40, e i tick passano alla forma compatta perché per esteso
              // non ci starebbero. Il fontSize NON cambia: textWidth.ts misura con
              // un font fisso, e ridurlo scollerebbe la misura dal disegno.
              tickFormatter={narrow ? compactTick : (v) => num(v, 0)}
              stroke={theme.axis}
              strokeWidth={theme.marks.gridWidth}
              tick={{ fill: theme.textMuted, fontSize: 11 }}
              tickLine={false}
              width={narrow ? 40 : 58}
            />
            {/* Crosshair + tooltip: sono il default su linee e aree, non un extra. */}
            <Tooltip
              content={tooltip}
              cursor={{ stroke: theme.axis, strokeWidth: theme.marks.gridWidth }}
              isAnimationActive={false}
            />

            {/* Il wash resta CONTINUO anche sui tratti incerti: un buco nel
                riempimento somiglierebbe a un valore andato a zero. */}
            <Area
              dataKey="value"
              stroke="none"
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
              activeDot={{
                r: theme.marks.markerMinSize / 2,
                fill: seriesColor,
                // Anello di 2px in colore superficie: il marker resta leggibile
                // dove attraversa la linea.
                stroke: theme.surface,
                strokeWidth: 2,
              }}
            />

            {/* Stessa serie, due tratti: solido dove il dato è completo,
                tratteggiato dove non lo è. Nessuna delle due è una serie in più —
                per questo non compaiono nel conteggio della legenda. */}
            <Area
              dataKey="solid"
              fill="none"
              stroke={seriesColor}
              strokeWidth={theme.marks.lineWidth}
              strokeLinecap={theme.marks.lineCap}
              strokeLinejoin="round"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
            <Area
              dataKey="dashed"
              fill="none"
              stroke={seriesColor}
              strokeWidth={theme.marks.lineWidth}
              strokeLinecap={theme.marks.lineCap}
              strokeDasharray={DASH_PARTIAL}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />

            {hasInvested ? (
              <Area
                dataKey="netInvested"
                fill="none"
                stroke={theme.textMuted}
                strokeWidth={theme.marks.lineWidth}
                strokeLinecap={theme.marks.lineCap}
                strokeDasharray={DASH_INVESTED}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            ) : null}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}
