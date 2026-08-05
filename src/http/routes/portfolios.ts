import express from "express";
import * as portfoliosRepo from "../../repo/portfolios";
import { asyncHandler, notFound, conflict } from "../errors";
import { z, body, params, idParam, currency } from "../validate";
import { errCode } from "../../util/err";

const router = express.Router();

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  baseCcy: currency().default("EUR"),
  broker: z.string().trim().max(120).nullish(),
});

router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    return res.json({ items: await portfoliosRepo.list() });
  })
);

router.post(
  "/",
  body(createBody),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const created = await portfoliosRepo.create(req.valid.body);
      return res.status(201).json(created);
    } catch (err) {
      if (errCode(err) === "23505") throw conflict("esiste già un portafoglio con questo nome");
      throw err;
    }
  })
);

router.patch(
  "/:id",
  params(z.object({ id: idParam() })),
  body(createBody.partial()),
  asyncHandler(async (req: Request, res: Response) => {
    const updated = await portfoliosRepo.update(req.valid.params.id, req.valid.body);
    if (!updated) throw notFound("portafoglio non trovato");
    return res.json(updated);
  })
);

export { router };
