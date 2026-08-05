// Serve la SPA compilata da web/dist. Registrato DOPO tutte le route /api.
//
// Su Fastify il fallback della SPA non è più una route con regex (la wildcard di
// Express), ma il notFoundHandler: `@fastify/static` viene registrato con
// `wildcard: false`, quindi registra una route per ogni file reale e tutto ciò che
// non corrisponde a un file cade qui. È lo stesso schema dello scaffold della
// piattaforma, ed elimina la dipendenza dalla semantica delle wildcard - che tra
// Express 4 e 5 è cambiata, ed era il motivo del negative lookahead di prima.
import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import config from "./config";
import logger from "./logger";

const DIST = path.join(__dirname, "..", "web", "dist");
const INDEX = path.join(DIST, "index.html");

/** Le rotte che NON devono mai ricevere il fallback SPA. */
const isApiPath = (url: string): boolean =>
  url.startsWith("/api/") || url === "/api" || url.startsWith("/healthz") || url.startsWith("/_self-en/");

const stubPage = (): string =>
  `<!doctype html><html lang="it"><head><meta charset="utf-8">
<title>${config.repoName}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f172a;color:#e2e8f0}
.card{max-width:34rem;padding:2rem}code{background:#1e293b;padding:.15rem .4rem;border-radius:.3rem}
a{color:#7dd3fc}</style></head><body><div class="card">
<h1>${config.repoName}</h1>
<p>La SPA non è stata compilata: <code>web/dist</code> non esiste.</p>
<p>Esegui <code>npm run build:web</code>, oppure in sviluppo usa
<code>npm run dev:web</code> e apri <a href="http://localhost:5173">:5173</a>.</p>
<p>L'API risponde comunque su <code>/api</code> e <code>/healthz</code>.</p>
</div></body></html>`;

async function mountStatic(app: FastifyInstance): Promise<void> {
  const hasBuild = fs.existsSync(INDEX);

  if (hasBuild) {
    // Gli asset di Vite hanno l'hash del contenuto nel nome → immutable, 1 anno.
    await app.register(fastifyStatic, {
      root: path.join(DIST, "assets"),
      prefix: "/assets/",
      wildcard: false,
      immutable: true,
      maxAge: "1y",
      decorateReply: true,
    });

    // Tutto il resto (favicon, manifest, …) con cache breve. `index: false` +
    // `wildcard: false`: index.html lo serve il notFoundHandler, che è l'unico
    // posto che ci mette `no-store`.
    await app.register(fastifyStatic, {
      root: DIST,
      prefix: "/",
      wildcard: false,
      index: false,
      maxAge: "5m",
      decorateReply: false,
    });
    logger.info({ dist: DIST }, "[static] SPA montata");
  } else {
    // Warning e stub, NON un crash: `npm run dev:api` da solo è un flusso di
    // lavoro legittimo (la SPA gira su :5173 col proxy di Vite).
    logger.warn(
      { dist: DIST },
      "[static] web/dist assente: servo uno stub. Esegui `npm run build:web`."
    );
  }

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    // Un endpoint API inesistente resta un 404 JSON: senza questo ramo cadrebbe
    // nel fallback SPA e un /api/typo riceverebbe index.html con status 200.
    if (isApiPath(req.url)) {
      return reply
        .code(404)
        .header("Cache-Control", "no-store")
        .send({ error: { code: "not_found", message: "endpoint non trovato" } });
    }

    // `/assets/` è ESCLUSO dal fallback, e non è un dettaglio: senza l'esclusione,
    // un bundle mancante (index.html in cache che punta a un asset di un deploy
    // precedente) riceverebbe index.html con status 200. Il browser proverebbe a
    // eseguire HTML come JavaScript e fallirebbe con "Unexpected token '<'" — un
    // errore che non nomina né il file mancante né la causa. Un 404 onesto è
    // diagnosticabile in un secondo.
    if (req.url.startsWith("/assets/")) {
      return reply
        .code(404)
        .type("text/plain")
        .header("Cache-Control", "no-store")
        .send("asset non trovato");
    }

    if (!hasBuild) {
      return reply.code(200).type("text/html").header("Cache-Control", "no-store").send(stubPage());
    }

    // Fallback del router lato client. no-store su index.html: è il file che punta
    // agli asset hashati, e una copia in cache dopo un deploy servirebbe riferimenti
    // a bundle che non esistono più.
    return reply.header("Cache-Control", "no-store").type("text/html").send(fs.readFileSync(INDEX));
  });
}

export { mountStatic, DIST, isApiPath };
