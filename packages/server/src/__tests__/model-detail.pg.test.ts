import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import express from "express";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { createModelDetailRouter, displayRates, loadModelDetail, type ModelDetail } from "../model-detail-api.js";
import { getPriceCatalog, PriceCatalog, setPriceCatalog } from "../price-catalog/catalog.js";
import { costFromRates } from "../price-catalog/compute.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

const close = (actual: number | null | undefined, expected: number, label: string) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test("catalog rates read per 1M tokens, and per unit for everything else", () => {
  assert.deepEqual(displayRates({ input: 3e-6, output: 1.5e-5, cacheRead: 3e-7, perCharacter: 0.00018, searchBilling: "query" }), {
    input: 3, output: 15, cacheRead: 0.3, perCharacter: 0.00018,
  });
});

test("a model's page: spend by day, usage, owners, recent calls and how it is priced", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_model_${suffix}`;
  const projectId = `project_model_${suffix}`;
  const previousCatalog = getPriceCatalog();
  const claude = "claude-sonnet-4-5-20250929";
  const claudePrice = {
    id: `price_claude_${suffix}`, source: "litellm" as const, provider: "anthropic", model: claude, sourceKey: claude, mode: "chat",
    effectiveFrom: "2020-01-01T00:00:00.000Z", effectiveTo: null,
    rates: { input: 3e-6, output: 1.5e-5, cacheRead: 3e-7, cacheWrite: 3.75e-6, cacheWrite1h: 6e-6 },
  };
  const ttsPrice = {
    id: `price_tts_${suffix}`, source: "costkey" as const, provider: "elevenlabs", model: "eleven_multilingual_v2", sourceKey: "eleven_multilingual_v2", mode: "audio_speech",
    effectiveFrom: "2020-01-01T00:00:00.000Z", effectiveTo: null, rates: { perCharacter: 0.00018 },
  };
  setPriceCatalog(new PriceCatalog([claudePrice, ttsPrice]));
  const app = express();
  app.use((req, _res, next) => { (req as any).user = { id: `owner-${suffix}`, orgId, role: "owner" }; next(); });
  app.use(createModelDetailRouter(pool));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Models',$2)", [orgId, `models-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Models',$2,$3)", [projectId, orgId, `key_${suffix}`]);

    const to = new Date(Date.UTC(2026, 9, 11, 0, 0, 0));
    const from = new Date(to.getTime() - 5 * 24 * 3_600_000);
    const day = (date: number, hour = 12, minute = 0) => new Date(Date.UTC(2026, 9, date, hour, minute)).toISOString();
    const call = (id: string, values: {
      when: string; trace: string | null; traceName?: string | null; provider: string; model: string | null; requestModel?: string | null;
      cost: number | null; basis?: string | null; source?: string | null; pricingId?: string | null; duration?: number; status?: number | null;
      lifecycle?: string | null; errorType?: string | null; input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null;
      units?: Record<string, number> | null; environment?: string;
    }) => pool.query(
      `INSERT INTO events (id, project_id, timestamp, provider, model, request_model, cost_usd, cost_basis, cost_source, pricing_id, duration_ms, status_code,
                           lifecycle_state, lifecycle_error_type, trace_id, trace_name, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, native_units, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [id, projectId, values.when, values.provider, values.model, values.requestModel ?? null, values.cost, values.basis ?? "unknown", values.source ?? null,
        values.pricingId ?? null, values.duration ?? 500, values.status === undefined ? 200 : values.status, values.lifecycle ?? null, values.errorType ?? null,
        values.trace, values.traceName ?? values.trace, values.input ?? null, values.output ?? null, values.cacheRead ?? null, values.cacheWrite ?? null,
        values.units ? JSON.stringify(values.units) : null, JSON.stringify({ environment: values.environment ?? "prod" })],
    );
    const span = (id: string, trace: string, kind: string, name: string, when: string) => pool.query(
      `INSERT INTO spans (id, project_id, trace_id, parent_span_id, kind, name, status, started_at, ended_at)
       VALUES ($1,$2,$3,NULL,$4,$5,'ok',$6,$6)`,
      [id, projectId, trace, kind, name, when],
    );

    // An agent run on 7 Oct: one Claude call with a cache hit and split cache writes, one other model.
    const cacheUnits = { cacheCreation5mTokens: 300, cacheCreation1hTokens: 200 };
    const agentCost = costFromRates(claudePrice.rates, { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 3_000, cacheCreationTokens: 500, nativeUnits: cacheUnits }, "anthropic", claude)!;
    await span("root_t1", "t1", "agent", "support", day(7));
    await call("c1", { when: day(7), trace: "t1", provider: "anthropic", model: claude, cost: agentCost, basis: "estimated", source: "catalog:litellm", pricingId: claudePrice.id,
      duration: 1_000, input: 1_000, output: 200, cacheRead: 3_000, cacheWrite: 500, units: cacheUnits });
    await call("other", { when: day(7, 12, 1), trace: "t1", provider: "openai", model: "gpt-4o", cost: 1, basis: "estimated", source: "pricing_table", input: 10, output: 10 });
    // A workflow run on 9 Oct with no spans: a reported cost, then a failed call with no price.
    await call("c2", { when: day(9), trace: "t2", traceName: "POST /api/chat", provider: "anthropic", model: claude, cost: 0.5, basis: "reported", source: "client_reported",
      duration: 3_000, input: 500, output: 100 });
    await call("c3", { when: day(9, 13), trace: "t2", traceName: "POST /api/chat", provider: "anthropic", model: claude, cost: null, basis: "unknown", status: 500,
      lifecycle: "failed", errorType: "InternalServerError", duration: 200 });
    // Another environment, and a call outside the window.
    await call("staging", { when: day(8), trace: "t3", provider: "anthropic", model: claude, cost: 9, basis: "estimated", source: "pricing_table", input: 1, output: 1, environment: "staging" });
    await call("before", { when: new Date(from.getTime() - 3_600_000).toISOString(), trace: "t0", provider: "anthropic", model: claude, cost: 9, input: 1, output: 1 });
    // A text-to-speech workflow billed in characters; one call only names the requested model.
    await call("tts1", { when: day(8), trace: "t4", traceName: "narrate", provider: "elevenlabs", model: "eleven_multilingual_v2", cost: 0.159, basis: "estimated", source: "catalog:costkey",
      duration: 10_100, units: { characters: 1_791 } });
    await call("tts2", { when: day(10), trace: "t5", traceName: "narrate", provider: "elevenlabs", model: null, requestModel: "eleven_multilingual_v2", cost: null, basis: "unknown",
      duration: 9_000, units: { characters: 907 } });

    const scope = { from: from.toISOString(), to: to.toISOString(), environment: "prod", timezone: "UTC" };
    const detail = await loadModelDetail(pool, projectId, { ...scope, provider: "anthropic", model: claude });

    assert.equal(detail.window.bucket, "day");
    assert.equal(detail.summary.calls, 3, "only this model, this environment, this window");
    assert.equal(detail.summary.failedCalls, 1);
    assert.equal(detail.summary.unpricedCalls, 0, "a failed call without a price isn't unpriced");
    assert.equal(detail.summary.pricedCalls, 2);
    close(detail.summary.cost, agentCost + 0.5, "cost");
    assert.equal(detail.summary.usage.inputTokens, 5_000, "Anthropic input counts cache reads and writes");
    assert.equal(detail.summary.usage.cacheReadTokens, 3_000);
    assert.equal(detail.summary.usage.cacheWriteTokens, 500);
    close(detail.summary.usage.cacheHitRate, 3_000 / 5_000, "hit rate");
    assert.equal(detail.summary.usage.outputTokens, 300);
    close(detail.summary.usage.cacheSavings, 3_000 * (3e-6 - 3e-7), "cache savings");
    assert.deepEqual(detail.summary.units, {});
    assert.equal(detail.summary.p50Ms, 1_000);
    assert.deepEqual(detail.cacheWrites, { total: 500, fiveMinute: 300, oneHour: 200 });

    assert.deepEqual(detail.series.map((point) => [point.bucket, point.calls]), [
      ["2026-10-06T00:00", 0], ["2026-10-07T00:00", 1], ["2026-10-08T00:00", 0], ["2026-10-09T00:00", 2], ["2026-10-10T00:00", 0],
    ], "every day in the window, empty days zero");
    close(detail.series[1]!.cost, agentCost, "7 Oct spend");
    close(detail.series[3]!.cost, 0.5, "9 Oct spend");
    assert.equal(detail.series[0]!.cost, 0);

    assert.deepEqual(detail.owners.map((owner) => [owner.kind, owner.name, owner.runs, owner.calls]), [
      ["workflow", "POST /api/chat", 1, 2],
      ["agent", "support", 1, 1],
    ], "sorted by this model's cost; the agent's other model isn't counted");
    close(detail.owners[1]!.cost, agentCost, "agent cost is this model's calls only");

    assert.deepEqual(detail.recentCalls.map((row) => row.id), ["c3", "c2", "c1"], "newest first");
    const failed = detail.recentCalls[0]!;
    assert.equal(failed.failed, true);
    assert.deepEqual(failed.status, { lifecycleState: "failed", errorType: "InternalServerError", statusCode: 500 });
    assert.equal(failed.traceName, "POST /api/chat");
    const first = detail.recentCalls[2]!;
    assert.deepEqual([first.traceId, first.inputTokens, first.outputTokens, first.durationMs], ["t1", 1_000, 200, 1_000]);
    assert.deepEqual(first.units, cacheUnits);
    assert.equal(first.timestamp, day(7));

    assert.equal(detail.price.current?.source, "catalog");
    assert.equal(detail.price.current?.catalogSource, "litellm");
    assert.equal(detail.price.current?.effectiveFrom, "2020-01-01T00:00:00.000Z");
    close(detail.price.current?.rates.input, 3, "input per 1M");
    close(detail.price.current?.rates.cacheWrite1h, 6, "1h cache write per 1M");
    assert.deepEqual(detail.price.sources.map((row) => [row.basis, row.source, row.calls]), [
      ["estimated", "catalog:litellm", 1], ["failed", null, 1], ["reported", "client_reported", 1],
    ]);

    const all = await loadModelDetail(pool, projectId, { ...scope, environment: null, provider: "anthropic", model: claude });
    assert.equal(all.summary.calls, 4, "every environment");

    // A characters model: no tokens, its billed units instead.
    const tts = await loadModelDetail(pool, projectId, { ...scope, provider: "elevenlabs", model: "eleven_multilingual_v2" });
    assert.equal(tts.summary.calls, 2, "a call naming only the requested model counts");
    assert.equal(tts.summary.unpricedCalls, 1);
    close(tts.summary.cost, 0.159, "tts cost");
    assert.equal(tts.summary.usage.inputTokens, null, "no token counts for a characters model");
    assert.equal(tts.summary.usage.outputTokens, null);
    assert.equal(tts.summary.usage.cacheHitRate, null);
    assert.equal(tts.summary.usage.cacheSavings, null);
    assert.deepEqual(tts.summary.units, { characters: 2_698 });
    assert.deepEqual(tts.cacheWrites, { total: null, fiveMinute: null, oneHour: null });
    assert.deepEqual(tts.owners.map((owner) => [owner.kind, owner.name, owner.runs, owner.calls]), [["workflow", "narrate", 2, 2]]);
    assert.deepEqual(tts.recentCalls.map((row) => [row.id, row.units]), [["tts2", { characters: 907 }], ["tts1", { characters: 1_791 }]]);
    assert.equal(tts.price.current?.catalogSource, "costkey");
    assert.equal(tts.price.current?.rates.perCharacter, 0.00018);
    assert.equal(tts.price.current?.rates.input, undefined);

    // Over HTTP: model names travel as query params.
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const query = new URLSearchParams({ provider: "elevenlabs", model: "eleven_multilingual_v2", from: scope.from, to: scope.to });
    const response = await fetch(`${baseUrl}/api/v1/projects/${projectId}/model-detail?${query}`);
    assert.equal(response.status, 200);
    const body = await response.json() as ModelDetail;
    assert.equal(body.window.timezone, "UTC");
    assert.equal(body.series.length, 5);
    assert.deepEqual(body.summary.units, { characters: 2_698 });
    const missing = await fetch(`${baseUrl}/api/v1/projects/${projectId}/model-detail?provider=anthropic`);
    assert.equal(missing.status, 400);
    const otherProject = await fetch(`${baseUrl}/api/v1/projects/not_${projectId}/model-detail?${query}`);
    assert.equal(otherProject.status, 404);
  } finally {
    setPriceCatalog(previousCatalog);
    await new Promise((resolve) => server.close(resolve));
    for (const table of ["spans", "events"]) await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});
