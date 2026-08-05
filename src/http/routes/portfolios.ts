import * as portfoliosRepo from "../../repo/portfolios";
import { notFound, conflict } from "../errors";
import { z, body, params, idParam, currency } from "../validate";
import { errCode } from "../../util/err";
import type { FastifyPluginAsync } from "fastify";


const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  baseCcy: currency().default("EUR"),
  broker: z.string().trim().max(120).nullish(),
});

const router: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    return reply.send({ items: await portfoliosRepo.list() });
  });

  app.post("/", { preHandler: [body(createBody)] }, async (req, reply) => {
    try {
      const created = await portfoliosRepo.create(req.valid.body);
      return reply.code(201).send(created);
    } catch (err) {
      if (errCode(err) === "23505") throw conflict("esiste già un portafoglio con questo nome");
      throw err;
    }
  });

  app.patch("/:id", { preHandler: [params(z.object({ id: idParam() })), body(createBody.partial())] }, async (req, reply) => {
    const updated = await portfoliosRepo.update(req.valid.params.id, req.valid.body);
    if (!updated) throw notFound("portafoglio non trovato");
    return reply.send(updated);
  });

  app.delete("/:id", { preHandler: [params(z.object({ id: idParam() }))] }, async (req, reply) => {
    const id = req.valid.params.id;
    const existing = await portfoliosRepo.byId(id);
    if (!existing) throw notFound("portafoglio non trovato");

    // 409 e non una cancellazione a cascata: perdere movimenti per un click è
    // irreparabile in un'app a inserimento manuale (stesso criterio di /instruments).
    const n = await portfoliosRepo.transactionCount(id);
    if (n > 0) {
      throw conflict(
        `il portafoglio ha ${n} movimenti collegati: elimina prima i movimenti`,
        { transactionCount: n }
      );
    }

    await portfoliosRepo.remove(id);
    return reply.code(204).send();
  });
};

export { router };
