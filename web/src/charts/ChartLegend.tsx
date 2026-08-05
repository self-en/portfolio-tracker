import { useId } from "react";
import { hatch45 } from "./chartTheme";

interface ChartLegendProps {
  items?: any;
  id: string;
}


// Legenda: presente SEMPRE da due serie in su, assente con una serie sola (il
// titolo la nomina già, e un box con una sola pastiglia ripete il titolo).
//
// Il testo indossa un token di TESTO. L'identità la porta il segno colorato
// accanto all'etichetta, e il segno RISPECCHIA la marca: rettangolo per barre e
// aree, tratto per le linee, tratto tratteggiato per le linee tratteggiate,
// rettangolo tessuto per la texture.

const safe = (raw) => String(raw).replace(/[^a-zA-Z0-9_-]/g, "");

function Key({ item, uid, index }) {
  const { mark = "rect", color, dash } = item;

  if (mark === "line") {
    return (
      <svg width="18" height="10" aria-hidden="true" focusable="false">
        <line
          x1="1"
          y1="5"
          x2="17"
          y2="5"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={dash || undefined}
        />
      </svg>
    );
  }

  if (mark === "texture") {
    const id = `${uid}-legend-hatch-${index}`;
    const h = hatch45(id, color, { spacing: 5, strokeWidth: 1.6 });
    return (
      <svg width="14" height="14" aria-hidden="true" focusable="false">
        <defs>
          <pattern {...h.patternProps}>
            <rect {...h.backgroundProps} />
            <path {...h.pathProps} />
          </pattern>
        </defs>
        <rect x="0" y="1" width="13" height="12" rx="2" fill={h.fill} />
      </svg>
    );
  }

  return (
    <svg width="14" height="14" aria-hidden="true" focusable="false">
      <rect x="0" y="1" width="13" height="12" rx="2" fill={color} />
    </svg>
  );
}

/**
 * @param {{items: Array<{label: string, color: string, mark?: "rect"|"line"|"texture", dash?: string, note?: string}>}} props
 */
export default function ChartLegend({ items, id }: ChartLegendProps) {
  const uid = safe(useId());
  const list = (items || []).filter(Boolean);
  if (list.length === 0) return null;

  return (
    <ul className="pt-legend" id={id}>
      {list.map((item, i) => (
        <li className="pt-legend-item" key={`${item.label}:${i}`}>
          <Key item={item} uid={uid} index={i} />
          <span>{item.label}</span>
          {item.note ? <span className="pt-legend-note">· {item.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}
