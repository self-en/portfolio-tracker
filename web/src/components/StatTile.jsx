import { toneOf } from "../format.js";

// Tessera KPI: etichetta · valore · delta (opzionale) · trend (opzionale).
//
// Il contratto della figura, non un grafico a una barra: quando il dato è un
// singolo numero corrente, il numero È il grafico.
//
// Il valore usa cifre PROPORZIONALI (il default del font): `tabular-nums` dà a
// ogni cifra la larghezza di uno zero e a 48px fa sembrare "121" slabbrato.
// Le cifre a larghezza fissa servono nelle colonne, cioè nella tabella.
//
// Nessun colore hardcodato: il tono del delta arriva dalle classi
// tone-up/tone-down/tone-flat di styles.css via `toneOf`, che decide dal SEGNO
// della stringa senza convertirla in numero.

/**
 * @param {object} props
 * @param {string} props.label etichetta, senza due punti finali
 * @param {string} props.value valore già formattato
 * @param {boolean} [props.hero] la cifra eroe della vista: ≥48px, una sola per pagina
 * @param {string} [props.delta] delta già formattato, con segno
 * @param {string} [props.deltaSource] la stringa decimale da cui ricavare il tono
 * @param {string} [props.deltaLabel] rispetto a quale periodo
 * @param {import("react").ReactNode} [props.sub] righe secondarie
 * @param {import("react").ReactNode} [props.spark]
 */
export default function StatTile({
  label,
  value,
  hero = false,
  delta,
  deltaSource,
  deltaLabel,
  sub,
  spark,
}) {
  return (
    <div className={hero ? "pt-tile pt-tile--hero" : "pt-tile"}>
      <span className="pt-tile-label">{label}</span>
      <span className={hero ? "pt-tile-value pt-tile-value--hero" : "pt-tile-value"}>{value}</span>

      {delta ? (
        <span className="pt-tile-delta">
          <span className={toneOf(deltaSource ?? delta)}>{delta}</span>
          {deltaLabel ? <span className="pt-tile-delta-label"> {deltaLabel}</span> : null}
        </span>
      ) : null}

      {sub ? <span className="pt-tile-sub">{sub}</span> : null}
      {spark ? <span className="pt-tile-spark">{spark}</span> : null}
    </div>
  );
}
