import { useId, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { money, monthLabel, num } from "../format";
import ChartFrame from "./ChartFrame";
import ChartTooltip from "./ChartTooltip";
import ColumnShape from "./ColumnShape";
import useChartTheme from "./useChartTheme";
import { hatch45 } from "./chartTheme";
import { toNumberOrZero } from "./numbers";

interface IncomeByMonthChartProps {
  items?: any;
  baseCcy?: string;
  refetching?: boolean;
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

const safe = (raw) => String(raw).replace(/[^a-zA-Z0-9_-]/g, "");

export default function IncomeByMonthChart({ items, baseCcy = "EUR", refetching = false }: IncomeByMonthChartProps) {
  const theme = useChartTheme();
  const hatchId = `${safe(useId())}-income-projected`;
  const hatch = hatch45(hatchId, theme.sequential);

  const data = useMemo(
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

  const legend = [
    hasConfirmed && {
      label: "Incassato",
      color: theme.sequential,
      mark: "rect",
      note: "c'è un movimento registrato",
    },
    hasProjected && {
      label: "Proiettato",
      color: theme.sequential,
      mark: "texture",
      note: "righe a 45°: stessa tinta, dato non ancora confermato",
    },
  ].filter(Boolean);

  const tooltip = ({ active, payload }) => {
    if (!active || !payload || payload.length === 0) return null;
    const point = payload[0]?.payload;
    if (!point) return null;
    const rows = [];
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
          {data.map((d) => (
            <tr key={d.month}>
              <td>{monthLabel(d.month)}</td>
              <td className="num">{money(d.raw.confirmed, baseCcy)}</td>
              <td className="num">{money(d.raw.projected, baseCcy)}</td>
              <td className="num">{money(d.raw.gross, baseCcy)}</td>
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
      <ResponsiveContainer width="100%" height={260}>
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
            minTickGap={8}
            interval="preserveStartEnd"
          />
          {/* Un solo asse y, senza identificatore d'asse: mai una seconda scala. */}
          <YAxis
            tickFormatter={(v) => num(v, 0)}
            stroke={theme.axis}
            strokeWidth={theme.marks.gridWidth}
            tick={{ fill: theme.textMuted, fontSize: 11 }}
            tickLine={false}
            width={58}
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
    </ChartFrame>
  );
}
