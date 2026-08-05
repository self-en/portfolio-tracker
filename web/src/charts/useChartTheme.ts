import { useEffect, useMemo, useState } from "react";
import { detectMode, getChartTheme } from "./chartTheme";

/**
 * Il tema dei grafici per la modalità corrente, che si aggiorna quando la
 * modalità cambia.
 *
 * La modalità scura NON è un flip automatico dei colori chiari: è un secondo set
 * di step scelto in chartTheme.js. Perché un cambio di tema si veda davvero
 * bisogna ri-renderizzare, quindi qui si ascoltano entrambe le sorgenti che
 * detectMode() consulta — la media query di sistema e l'attributo data-theme.
 */
export default function useChartTheme() {
  const [mode, setMode] = useState(() => detectMode());

  useEffect(() => {
    const sync = () => setMode(detectMode());

    const mq = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
    mq?.addEventListener?.("change", sync);

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    // La prima lettura è avvenuta durante il render iniziale, quando in SSR
    // document non esiste: si risincronizza al mount.
    sync();

    return () => {
      mq?.removeEventListener?.("change", sync);
      observer.disconnect();
    };
  }, []);

  return useMemo(() => getChartTheme(mode), [mode]);
}
