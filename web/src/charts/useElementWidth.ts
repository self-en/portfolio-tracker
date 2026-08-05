import { useEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * Larghezza in px di un elemento, osservata.
 *
 * Serve alla barra di allocazione per sapere se un'etichetta diretta entra in un
 * segmento: senza la larghezza reale si finirebbe per tagliare il testo, che è
 * peggio del non stamparlo.
 */
export default function useElementWidth(ref: RefObject<Element | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;

    const read = () => setWidth(node.getBoundingClientRect().width);
    read();

    if (typeof ResizeObserver !== "function") {
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }

    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
