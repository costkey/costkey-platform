import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { cachedSummaries, invalidateOnChange, invalidateSummaries } from "../response-cache.js";

test("summaries are served from the cache per user, and a change to the project drops them", async () => {
  invalidateSummaries();
  let computed = 0;
  const app = express();
  app.use((req, _res, next) => { (req as any).user = { id: String(req.headers["x-user"] ?? "u1"), role: "owner" }; next(); });
  app.use(invalidateOnChange());
  app.get("/api/v1/projects/:projectId/overview", cachedSummaries(), (_req, res) => { computed += 1; res.json({ computed }); });
  app.post("/api/v1/projects/:projectId/pricing/rates", (_req, res) => { res.json({ ok: true }); });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (user = "u1", to = new Date().toISOString()) => {
    const response = await fetch(`${base}/api/v1/projects/p1/overview?from=2026-10-01T00:00:00.000Z&to=${encodeURIComponent(to)}`, { headers: { "x-user": user } });
    return { body: await response.json() as { computed: number }, cache: response.headers.get("x-costkey-cache") };
  };
  try {
    assert.deepEqual((await get()).body, { computed: 1 });
    const again = await get("u1", new Date(Date.now() + 2_000).toISOString());
    assert.deepEqual(again.body, { computed: 1 }, "a 'to' of now, seconds later, is the same request");
    assert.equal(again.cache, "fresh");
    assert.deepEqual((await get("u2")).body, { computed: 2 }, "another user never gets this user's entry");
    await fetch(`${base}/api/v1/projects/p1/pricing/rates`, { method: "POST" });
    assert.deepEqual((await get()).body, { computed: 3 }, "a price change drops the project's summaries");
  } finally {
    server.close();
    invalidateSummaries();
  }
});
