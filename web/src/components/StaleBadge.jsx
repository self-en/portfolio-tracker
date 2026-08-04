import { time } from "../format.js";

/**
 * Stato di freschezza dei prezzi.
 *
 * `stale` arriva dal server e non viene ricalcolato qui: è il server che conosce
 * il calendario di borsa e sa distinguere "il listino è chiuso da venerdì" da
 * "il refresh è fallito".
 */
export default function StaleBadge({ asOf, stale = false }) {
  if (!asOf && !stale) return null;

  if (stale || !asOf) {
    return (
      <span className="badge badge--stale" title="L'ultimo aggiornamento prezzi non è andato a buon fine">
        dati non aggiornati
      </span>
    );
  }

  return <span className="badge badge--fresh">prezzi aggiornati alle {time(asOf)}</span>;
}
