import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase, shutdownDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { createEffectivePrice, repriceHistoricalForEffectivePrice } from "../effective-prices.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("effective-price writes reprice only unknown historical observations", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_price_${suffix}`;
  const projectId = `project_price_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Price','price-' || $1)", [orgId]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Price',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    await pool.query(
      `INSERT INTO events(id,project_id,timestamp,provider,model,input_tokens,output_tokens,cost_basis,cost_currency,context,event_type)
       VALUES ($1,$2,'2026-09-02T00:00:00Z','openai','gpt-4o',10,5,'unknown','USD',$3,'call'),
              ($4,$2,'2026-09-02T00:00:00Z','openai','gpt-4o',10,5,'reported','USD',$3,'call')`,
      [`event_unknown_${suffix}`, projectId, JSON.stringify({ accountScope: "acct" }), `event_reported_${suffix}`],
    );
    const base = {
      provider: "openai", accountScope: "acct", model: "gpt-4o", currency: "USD",
      effectiveFrom: "2026-09-01T00:00:00Z", effectiveTo: null,
      source: "negotiated", version: 1, metadata: {},
    } as const;
    await createEffectivePrice(pool, projectId, { ...base, nativeUnit: "input_tokens", pricePerUnit: 0.1 }, `price_input_${suffix}`, { role: "owner" });
    await createEffectivePrice(pool, projectId, { ...base, nativeUnit: "output_tokens", pricePerUnit: 0.2 }, `price_output_${suffix}`, { role: "owner" });
    const repriced = await repriceHistoricalForEffectivePrice(pool, projectId, `price_output_${suffix}`);
    assert.equal(repriced.updatedCount, 1);
    const rows = await pool.query("SELECT id,cost_usd,cost_basis,cost_source,pricing_id FROM events WHERE project_id = $1 ORDER BY id", [projectId]);
    const unknown = rows.rows.find((row) => String(row.id).includes("unknown"));
    const reported = rows.rows.find((row) => String(row.id).includes("reported"));
    assert.equal(Number(unknown.cost_usd), 2);
    assert.equal(unknown.cost_basis, "estimated");
    assert.equal(unknown.cost_source, "effective_price_override");
    assert.match(String(unknown.pricing_id), /price_output/);
    assert.equal(reported.cost_usd, null, "a provider-reported basis without amount remains untouched");
  } finally {
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM effective_prices WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});
