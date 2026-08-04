const express = require("express");
const portfoliosRepo = require("../../repo/portfolios");
const { asyncHandler, notFound, conflict } = require("../errors");
const { z, body, params, idParam, currency } = require("../validate");

const router = express.Router();

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  baseCcy: currency().default("EUR"),
  broker: z.string().trim().max(120).nullish(),
});

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    return res.json({ items: await portfoliosRepo.list() });
  })
);

router.post(
  "/",
  body(createBody),
  asyncHandler(async (req, res) => {
    try {
      const created = await portfoliosRepo.create(req.valid.body);
      return res.status(201).json(created);
    } catch (err) {
      if (err?.code === "23505") throw conflict("esiste già un portafoglio con questo nome");
      throw err;
    }
  })
);

router.patch(
  "/:id",
  params(z.object({ id: idParam() })),
  body(createBody.partial()),
  asyncHandler(async (req, res) => {
    const updated = await portfoliosRepo.update(req.valid.params.id, req.valid.body);
    if (!updated) throw notFound("portafoglio non trovato");
    return res.json(updated);
  })
);

module.exports = { router };
