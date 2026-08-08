import { useId, useMemo, useRef } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { money, monthLabel, num } from "../format";
import ChartFrame from "./ChartFrame";
import ChartTooltip, { pointOf } from "./ChartTooltip";
import ColumnShape from "./ColumnShape";
import useChartTheme from "./useChartTheme";
import useElementWidth from "./useElementWidth";
import { hatch45 } from "./chartTheme";
import { compactTick, toNumberOrZero } from "./numbers";
import type { TooltipRenderProps, TooltipRow } from "./ChartTooltip";
import type { LegendItems } from "./ChartLegend";
import type { MonthlyIncomeTotal } from "../types";

interface IncomeByMonthChartProps {
  items?: MonthlyIncomeTotal[];
  baseCcy?: string;
  refetching?: boolean;
}

/**
 * Una colonna: i due valori in float per l'altezza dello stack, e `raw` con le
 * stringhe originali - il tooltip e la tabella formattano quelle, mai il float.
 */
interface IncomeColumn {
  month: string;
  confirmedValue: number;
  projectedValue: number;
  raw: MonthlyIncomeTotal;
}


// REDDITI PER MESE — colonne, tinta blu SINGOLA.
//
// Il compito del lettore è la GRANDEZZA ("quanto incasso a luglio?"), non
// l'identità: una tinta sola basta e la sequenziale è il default sicuro. Otto
// tinte categoriche qui sarebbero il modo più comune di mancare il punto di un
// grafico.
//
// Confermato e proiettato si distinguono col canale TEXTURE (righe a 45°, tono su
// tono), NON con una seconda tinta: la distinzione non è di identità ma di
// CERTEZZA del dato, e una seconda tinta implicherebbe una seconda categoria.
// È esattamente il caso motivato dall'accessibilità per cui la texture è
// riservata, e la legenda la spiega a parole.

const safe = (raw: string) => String(raw).replace(/[^a-zA-Z0-9_-]/g, "");

export default function IncomeByMonthChart({ items, baseCcy = "EUR", refetching = false }: IncomeByMonthChartProps) {
  const theme = useChartTheme();
  const hatchId = `${safe(useId())}-income-projected`;
  const hatch = hatch45(hatchId, theme.sequential);

  // Come in ValueSeriesChart: la larghezza misurata del plot, non un breakpoint.
  // A 0 (primo render) valgono i numeri desktop, così non c'è salto di layout.
  const plotRef = useRef<HTMLDivElement>(null);
  const plotWidth = useElementWidth(plotRef);
  const narrow = plotWidth > 0 && plotWidth < 480;

  const data = useMemo<IncomeColumn[]>(
    () =>
      (items || []).map((it) => ({
        month: it.month,
        confirmedValue: toNumberOrZero(it.confirmed),
        projectedValue: toNumberOrZero(it.projected),
        raw: it,
      })),
    [items]
  );

  const hasProjected = data.some((d) => d.projectedValue > 0);
  const hasConfirmed = data.some((d) => d.confirmedValue > 0);

  const legend: LegendItems = [
    hasConfirmed && {
      label: "Incassato",
      color: theme.sequential,
      mark: "rect" as const,
      note: "c'è un movimento registrato",
    },
    hasProjected && {
      label: "Proiettato",
      color: theme.sequential,
      mark: "texture" as const,
      note: "righe a 45°: stessa tinta, dato non ancora confermato",
    },
  ];

  const tooltip = (props: TooltipRenderProps) => {
    const point = pointOf<IncomeColumn>(props);
    if (!point) return null;
    const rows: TooltipRow[] = [];
    if (point.confirmedValue > 0) {
      rows.push({
        label: "Incassato",
        value: money(point.raw.confirmed, baseCcy),
        color: theme.sequential,
        mark: "rect",
      });
    }
    if (point.projectedValue > 0) {
      rows.push({
        label: "Proiettato",
        value: money(point.raw.projected, baseCcy),
        color: theme.sequential,
        mark: "rect",
      });
    }
    rows.push({
      label: "Totale lordo",
      value: money(point.raw.gross, baseCcy),
      color: theme.textMuted,
      mark: "rect",
    });
    return <ChartTooltip title={monthLabel(point.month)} rows={rows} />;
  };

  const table = (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Redditi lordi attesi e incassati per mese</caption>
        <thead>
          <tr>
            <th scope="col">Mese</th>
            <th scope="col" className="num">
              Incassato
            </th>
            <th scope="col" className="num">
              Proiettato
            </th>
            <th scope="col" className="num">
              Totale lordo
            </th>
          </tr>
        </thead>
        <tbody>
          {/* data-label ripete l'intestazione: sotto i 640px la riga diventa una
              scheda e senza di esso resterebbe una colonna di numeri anonimi. */}
          {data.map((d) => (
            <tr key={d.month}>
              <td data-label="Mese">{monthLabel(d.month)}</td>
              <td className="num" data-label="Incassato">
                {money(d.raw.confirmed, baseCcy)}
              </td>
              <td className="num" data-label="Proiettato">
                {money(d.raw.projected, baseCcy)}
              </td>
              <td className="num" data-label="Totale lordo">
                {money(d.raw.gross, baseCcy)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (data.length === 0) return null;

  return (
    <ChartFrame
      title="Redditi lordi per mese"
      subtitle={`Cedole e dividendi in ${baseCcy}. I rimborsi a scadenza sono esclusi: sono capitale che rientra, non reddito.`}
      legend={legend}
      refetching={refetching}
      note="Gli importi sono LORDI: la ritenuta si registra alla conferma dell'incasso."
      table={table}
    >
      <div ref={plotRef}>
        <ResponsiveContainer width="100%" height={narrow ? 190 : 260}>
          <BarChart
            data={data}
            margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
            // Colonne spesse al massimo 24px: la banda che resta è aria, non si
            // riempie.
            maxBarSize={theme.marks.barMaxThickness}
            barCategoryGap="22%"
          >
            <defs>
              <pattern {...hatch.patternProps}>
                <rect {...hatch.backgroundProps} />
                <path {...hatch.pathProps} />
              </pattern>
            </defs>

            <CartesianGrid
              stroke={theme.grid}
              strokeWidth={theme.marks.gridWidth}
              vertical={false}
            />
            <XAxis
              dataKey="month"
              tickFormatter={monthLabel}
              stroke={theme.axis}
              strokeWidth={theme.marks.gridWidth}
              tick={{ fill: theme.textMuted, fontSize: 11 }}
              tickLine={false}
              // 44 come in ValueSeriesChart: con 8 le dodici etichette "gen 2025" si
              // sovrapponevano in 270px, e con preserveStartEnd recharts ne salta
              // quante serve invece di stamparle addosso l'una all'altra.
              minTickGap={44}
              interval="preserveStartEnd"
            />
            {/* Un solo asse y, senza identificatore d'asse: mai una seconda scala. */}
            <YAxis
              // Vedi ValueSeriesChart: asse a 40px e tick compatti sui plot stretti,
              // fontSize invariato.
              tickFormatter={narrow ? compactTick : (v) => num(v, 0)}
              stroke={theme.axis}
              strokeWidth={theme.marks.gridWidth}
              tick={{ fill: theme.textMuted, fontSize: 11 }}
              tickLine={false}
              width={narrow ? 40 : 58}
            />
            {/* Su barre e colonne la MARCA è il bersaglio: niente crosshair. */}
            <Tooltip content={tooltip} cursor={false} isAnimationActive={false} />

            <Bar
              dataKey="confirmedValue"
              stackId="income"
              fill={theme.sequential}
              shape={<ColumnShape segment="confirmed" />}
              activeBar={<ColumnShape segment="confirmed" fillOpacity={0.82} />}
              isAnimationActive={false}
            />
            <Bar
              dataKey="projectedValue"
              stackId="income"
              fill={hatch.fill}
              shape={<ColumnShape segment="projected" />}
              activeBar={<ColumnShape segment="projected" fillOpacity={0.82} />}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}
