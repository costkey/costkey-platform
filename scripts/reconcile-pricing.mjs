// Dry run: node scripts/reconcile-pricing.mjs
// Apply the reviewed repair: node scripts/reconcile-pricing.mjs --apply
// Uses the currently linked Railway Postgres service. Never prints credentials or bodies.
import { execFileSync } from "node:child_process";
import pg from "pg";

const apply = process.argv.includes("--apply");
const variables = JSON.parse(execFileSync("railway", ["variables", "--service", "Postgres", "--json"], { encoding: "utf8" }));
const client = new pg.Client({ connectionString: variables.DATABASE_PUBLIC_URL, statement_timeout: 30000 });
try {
  await client.connect();
  await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
  const result = await client.query(`
    SELECT id, project_id, model, cost_usd, response_body->'usage' AS usage,
      input_tokens, output_tokens, bl_file, bl_function, bl_line
    FROM events
    WHERE provider = 'openrouter' AND cost_usd IS NULL
    ORDER BY id ${apply ? "FOR UPDATE" : ""}
  `);
  const changes = [];
  for (const row of result.rows) {
    const reported = row.usage?.cost;
    let next = row.cost_usd;
    let reason = "";
    if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
      next = reported;
      reason = "saved_openrouter_usage_cost";
    } else if (row.model === "google/gemini-3.1-flash-image"
      && [747, 1120, 1680, 2520].includes(row.output_tokens ?? -1)
      && row.input_tokens != null) {
      next = (row.input_tokens / 1_000_000) * 0.5
        + ((row.output_tokens ?? 0) / 1_000_000) * 60;
      reason = "legacy_gemini_31_image_unit";
    } else if (row.model === "google/gemini-2.5-flash-image"
      && row.output_tokens === 1290 && row.input_tokens != null) {
      next = (row.input_tokens / 1_000_000) * 0.3
        + (row.output_tokens / 1_000_000) * 30;
      reason = "legacy_gemini_25_image_unit";
    } else if (row.model === "text-embedding-3-small" && row.cost_usd == null && row.input_tokens != null) {
      next = row.input_tokens * 0.02 / 1_000_000;
      reason = "embedding_standard_estimate";
    }
    if (next !== row.cost_usd) changes.push({ ...row, next, reason });
  }
  const byReason = {};
  for (const row of changes) byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run", inspected: result.rows.length,
    changed: changes.length, byReason,
    oldKnownSubtotal: changes.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0),
    newKnownSubtotal: changes.reduce((sum, row) => sum + (row.next ?? 0), 0),
  }, null, 2));
  if (apply) {
    await client.query(`CREATE TABLE IF NOT EXISTS pricing_repair_20260906_v2 (
      project_id TEXT NOT NULL, event_id TEXT NOT NULL,
      old_cost DOUBLE PRECISION, new_cost DOUBLE PRECISION,
      PRIMARY KEY (project_id, event_id),
      reason TEXT NOT NULL, repaired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    for (const row of changes) {
      await client.query("INSERT INTO pricing_repair_20260906_v2(project_id,event_id,old_cost,new_cost,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [row.project_id, row.id, row.cost_usd, row.next, row.reason]);
      await client.query("UPDATE events SET cost_usd=$1 WHERE project_id=$2 AND id=$3", [row.next, row.project_id, row.id]);
      if (row.bl_function) {
        const key = `${row.bl_file ?? "unknown"}:${row.bl_function}:${row.bl_line ?? 0}`;
        await client.query(`UPDATE call_site_stats SET total_cost_usd=total_cost_usd+$1
          WHERE project_id=$2 AND call_site_key=$3 AND model=$4`,
          [(row.next ?? 0) - (row.cost_usd ?? 0), row.project_id, key, row.model ?? "unknown"]);
      }
    }
    await client.query("COMMIT");
    console.log("Committed; original costs retained in pricing_repair_20260906.");
  } else {
    await client.query("ROLLBACK");
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("Pricing reconciliation failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
} finally {
  await client.end();
}
