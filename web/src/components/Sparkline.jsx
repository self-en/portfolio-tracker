import sparklinePath from "../charts/sparklinePath.js";
import useChartTheme from "../charts/useChartTheme.js";

/**
 * Sparkline di una tessera KPI: la linea nella tinta de-enfatizzata, il punto
 * finale nell'accento.
 *
 * La conversione dei decimali in coordinate sta in charts/sparklinePath.js —
 * questo componente non fa aritmetica, disegna.
 *
 * `aria-hidden`: è un ornamento informativo. Il valore corrente sta scritto in
 * chiaro nella tessera e la serie completa è nel grafico del valore, con la sua
 * vista tabellare.
 */
export default function Sparkline({ values, width = 132, height = 34, label }) {
  const theme = useChartTheme();
  const geom = sparklinePath(values, { width, height });

  if (!geom) return null;

  return (
    <svg
      width={geom.width}
      height={geom.height}
      viewBox={`0 0 ${geom.width} ${geom.height}`}
      role="img"
      aria-label={label}
      focusable="false"
    >
      <path
        d={geom.d}
        fill="none"
        stroke={theme.textMuted}
        strokeWidth={theme.marks.lineWidth}
        strokeLinecap={theme.marks.lineCap}
        strokeLinejoin="round"
      />
      {geom.last ? (
        <circle
          cx={geom.last.x}
          cy={geom.last.y}
          r={theme.marks.markerMinSize / 2}
          fill={theme.series(0)}
          // Anello di 2px in colore superficie: il punto resta leggibile dove
          // incrocia la linea.
          stroke={theme.surface}
          strokeWidth={2}
        />
      ) : null}
    </svg>
  );
}
