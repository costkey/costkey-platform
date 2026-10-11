import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { createIngestRouter } from "../ingest.js";
import { createEffectivePrice } from "../effective-prices.js";
import { invalidateProjectPrices } from "../billing.js";
import { getPriceCatalog, PriceCatalog, setPriceCatalog } from "../price-catalog/catalog.js";
import { ensurePriceCatalogSchema, repriceUnpricedEvents, syncPriceCatalog } from "../price-catalog/sync.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

function litellm(price: number): Record<string, unknown> {
  return {
    "gpt-test-9": { litellm_provider: "openai", input_cost_per_token: price, output_cost_per_token: price * 4 },
    "eleven_test_v9": { litellm_provider: "elevenlabs", input_cost_per_character: 0.0002 },
  };
}

test("price catalog sync stores versions, guards against broken feeds and reprices unpriced calls", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_prices_${suffix}`;
  const projectId = `project_prices_${suffix}`;
  const key = `key_prices_${suffix}`;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const previous = getPriceCatalog();
  try {
    await initDatabase();
    await ensurePriceCatalogSchema(pool);
    // The catalog is global; this test database starts it from nothing.
    await pool.query("DELETE FROM model_prices");
    await pool.query("DELETE FROM pricing_sync_runs");
    setPriceCatalog(new PriceCatalog([]));
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [orgId, "Prices", `prices-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Prices',$2,$3)", [projectId, orgId, key]);
    app.use(createIngestRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const at = new Date(Date.now() - 60_000).toISOString();
      const call = (id: string, provider: string, model: string, usage: Record<string, unknown>) => ({
        id: `${id}_${suffix}`, timestamp: at, durationMs: 100, provider, model, url: `https://api.${provider}.com/v1/x`, usage,
      });
      const response = await fetch(`${baseUrl}/api/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          sdkVersion: "0.6.0",
          events: [
            call("new_model", "openai", "gpt-test-9", { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }),
            call("tts", "elevenlabs", "eleven_test_v9", { inputTokens: null, outputTokens: null, nativeUnits: { characters: 500 } }),
            call("deployment", "openai", "prod-deployment-7", { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }),
            call("custom", "selfhosted", "acme-llm", { inputTokens: 2000, outputTokens: 500, totalTokens: 2500 }),
          ],
        }),
      });
      assert.equal(response.status, 202);
      const unpriced = await pool.query("SELECT COUNT(*)::int AS count FROM events WHERE project_id = $1 AND cost_usd IS NULL", [projectId]);
      assert.equal(unpriced.rows[0].count, 4, "nothing knows these models yet");

      // A new model lands in the catalogs: the sync prices the waiting calls.
      const first = await syncPriceCatalog(pool, { trigger: "test", payloads: { litellm: litellm(1e-6), models_dev: {}, openrouter: { data: [] } } });
      assert.equal(first.sources["litellm"]?.status, "ok");
      assert.equal(first.sources["models_dev"]?.status, "rejected", "an empty feed never wipes prices");
      assert.equal(first.added, 2);
      assert.equal(first.repriced, 2);
      const priced = await pool.query(
        "SELECT id, cost_usd, cost_basis, cost_source, pricing_id FROM events WHERE project_id = $1 AND cost_usd IS NOT NULL ORDER BY id",
        [projectId],
      );
      const byId = new Map(priced.rows.map((row) => [String(row.id).replace(`_${suffix}`, ""), row]));
      assert.ok(Math.abs(Number(byId.get("new_model").cost_usd) - (1000 * 1e-6 + 100 * 4e-6)) < 1e-12);
      assert.equal(byId.get("new_model").cost_source, "catalog:litellm");
      assert.match(String(byId.get("new_model").pricing_id), /^mp_/);
      assert.ok(Math.abs(Number(byId.get("tts").cost_usd) - 0.1) < 1e-12);

      // A price change opens a new version; history keeps the old rate.
      const second = await syncPriceCatalog(pool, { trigger: "test", payloads: { litellm: litellm(2e-6), models_dev: {}, openrouter: { data: [] } } });
      assert.equal(second.changed, 1);
      const versions = await pool.query(
        "SELECT effective_from, effective_to FROM model_prices WHERE source_key = 'gpt-test-9' ORDER BY effective_from",
      );
      assert.equal(versions.rows.length, 2);
      assert.ok(versions.rows[0].effective_to, "the old version is closed");
      assert.equal(getPriceCatalog().resolve({ provider: "openai", model: "gpt-test-9", at })?.price.rates.input, 1e-6);
      assert.equal(getPriceCatalog().resolve({ provider: "openai", model: "gpt-test-9" })?.price.rates.input, 2e-6);

      // An alias prices an Azure deployment name as a catalog model.
      await pool.query(
        "INSERT INTO model_aliases (project_id, provider, model, target_model) VALUES ($1, 'openai', 'prod-deployment-7', 'gpt-test-9')",
        [projectId],
      );
      // A project's own rates price a model no catalog will ever list.
      await createEffectivePrice(pool, projectId, { provider: "selfhosted", accountScope: "*", model: "acme-llm", nativeUnit: "input_tokens", pricePerUnit: 1e-7, currency: "USD", effectiveFrom: "1970-01-01T00:00:00.000Z", source: "user_supplied", version: 1 }, `price_in_${suffix}`, { id: null, role: "owner" });
      await createEffectivePrice(pool, projectId, { provider: "selfhosted", accountScope: "*", model: "acme-llm", nativeUnit: "output_tokens", pricePerUnit: 2e-7, currency: "USD", effectiveFrom: "1970-01-01T00:00:00.000Z", source: "user_supplied", version: 1 }, `price_out_${suffix}`, { id: null, role: "owner" });
      invalidateProjectPrices(projectId);
      assert.equal(await repriceUnpricedEvents(pool, { projectId }), 2);
      const rest = await pool.query(
        "SELECT id, cost_usd, cost_source FROM events WHERE project_id = $1 AND id = ANY($2::text[]) ORDER BY id",
        [projectId, [`custom_${suffix}`, `deployment_${suffix}`]],
      );
      assert.equal(rest.rows[0].cost_source, "project_price");
      assert.ok(Math.abs(Number(rest.rows[0].cost_usd) - (2000 * 1e-7 + 500 * 2e-7)) < 1e-12);
      assert.equal(rest.rows[1].cost_source, "catalog:litellm");
      const left = await pool.query("SELECT COUNT(*)::int AS count FROM events WHERE project_id = $1 AND cost_usd IS NULL", [projectId]);
      assert.equal(left.rows[0].count, 0);

      const runs = await pool.query("SELECT status, added, changed, repriced FROM pricing_sync_runs ORDER BY started_at");
      assert.deepEqual(runs.rows.map((row) => row.status), ["partial", "partial"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    setPriceCatalog(previous);
    await pool.query("DELETE FROM model_prices").catch(() => undefined);
    await pool.query("DELETE FROM pricing_sync_runs").catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});
