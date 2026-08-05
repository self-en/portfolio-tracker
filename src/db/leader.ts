// Leader election via advisory lock Postgres.
//
// Vive in db/ e non in market/ perché è una questione di gestione della
// CONNESSIONE, non di schedulazione: l'advisory lock è session-scoped, quindi
// richiede un client dedicato tenuto aperto per tutta la durata della leadership.
// Lo scheduler chiede "sono leader?" e non sa nulla di client pg.
//
// Il vantaggio di questo meccanismo: se la connessione muore, il lock si rilascia
// DA SOLO. Nessun TTL, nessun heartbeat, nessuna riga di stato da ripulire — e un
// altro pod prende la leadership al tick successivo.
import { getPool } from "./pool";
import logger from "../logger";
import { errMessage } from "../util/err";

// Chiave distinta da MIGRATION_LOCK_KEY (918273645): due lock diversi non devono
// contendersi lo stesso slot.
const SCHEDULER_LOCK_KEY = 918273646;

class Leadership {
  constructor(lockKey = SCHEDULER_LOCK_KEY, label = "scheduler") {
    this.lockKey = lockKey;
    this.label = label;
    this.client = null;
    this.isLeader = false;
  }

  /** Tenta di acquisire la leadership. Non lancia mai. */
  async tryAcquire() {
    const pool = getPool();
    if (!pool) return false;
    try {
      if (!this.client) this.client = await pool.connect();
      const { rows } = await this.client.query("SELECT pg_try_advisory_lock($1) AS ok", [
        this.lockKey,
      ]);
      // pg restituisce boolean, ma un driver alternativo potrebbe dare 't'.
      const ok = rows[0]?.ok === true || rows[0]?.ok === "t";
      if (ok && !this.isLeader) {
        logger.info({ label: this.label }, "[leader] leadership acquisita");
      } else if (!ok && this.isLeader) {
        logger.warn({ label: this.label }, "[leader] leadership perduta");
      }
      this.isLeader = ok;
      return ok;
    } catch (err) {
      logger.warn({ label: this.label, err: errMessage(err) }, "[leader] acquisizione fallita");
      // Connessione probabilmente morta: si scarta con `release(true)` così il pool
      // la distrugge invece di riciclarla, e il prossimo tentativo ne apre una nuova.
      try {
        this.client?.release(true);
      } catch {
        /* ignora */
      }
      this.client = null;
      this.isLeader = false;
      return false;
    }
  }

  async release() {
    if (!this.client) {
      this.isLeader = false;
      return;
    }
    try {
      await this.client.query("SELECT pg_advisory_unlock($1)", [this.lockKey]);
      this.client.release();
    } catch {
      try {
        this.client.release(true);
      } catch {
        /* ignora */
      }
    }
    this.client = null;
    this.isLeader = false;
  }
}

export { Leadership, SCHEDULER_LOCK_KEY };
