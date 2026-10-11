import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase, shutdownDatabase } from "../db.js";
import { createIngestRouter } from "../ingest.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { skeleton, telemetryFor } from "./helpers/skeleton.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

async function post(baseUrl: string, path: string, key: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

const CALL_COLUMNS = `provider, model, request_model, url, method, status_code, input_tokens, output_tokens, total_tokens,
  reasoning_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_basis, cost_source, duration_ms, streaming,
  ttft, tps, stream_duration, chunk_count, charge_id, native_units, image_output_tokens, bl_function, bl_file,
  call_site_frames, call_site_raw, lifecycle_state, lifecycle_error_type, raw_telemetry, timestamp`;

test("raw telemetry ingest stores the same columns as the legacy path", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_tel_${suffix}`;
  const projectId = `project_tel_${suffix}`;
  const key = `key_tel_${suffix}`;
  const metaProjectId = `project_telmeta_${suffix}`;
  const metaKey = `key_telmeta_${suffix}`;
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [orgId, "Telemetry", `tel-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Tel',$2,$3), ($4,'TelMeta',$2,$5)", [projectId, orgId, key, metaProjectId, metaKey]);
    await pool.query(
      `INSERT INTO project_settings(project_id, capture_mode, body_capture_enabled, source_access_enabled)
       VALUES ($1, 'text', true, true), ($2, 'metadata', false, true)
       ON CONFLICT (project_id) DO UPDATE SET capture_mode = EXCLUDED.capture_mode,
         body_capture_enabled = EXCLUDED.body_capture_enabled, source_access_enabled = EXCLUDED.source_access_enabled`,
      [projectId, metaProjectId],
    );
    app.use(createIngestRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      const frames = [
        { functionName: "costKeyFetchWrapper", fileName: "/app/node_modules/costkey/dist/fetch-patch.js", lineNumber: 1, columnNumber: 1 },
        { functionName: "OpenAI.makeRequest", fileName: "/app/node_modules/openai/core.js", lineNumber: 2, columnNumber: 1 },
        { functionName: "summarize", fileName: "/app/src/summarize.ts", lineNumber: 12, columnNumber: 3 },
        { functionName: "handler", fileName: "/app/src/routes.ts", lineNumber: 40, columnNumber: 9 },
      ];
      const raw = [
        "Error",
        "    at costKeyFetchWrapper (/app/node_modules/costkey/dist/fetch-patch.js:1:1)",
        "    at OpenAI.makeRequest (/app/node_modules/openai/core.js:2:1)",
        "    at summarize (/app/src/summarize.ts:12:3)",
        "    at handler (/app/src/routes.ts:40:9)",
      ].join("\n");
      const responseBody = {
        id: "chatcmpl-parity", object: "chat.completion", model: "gpt-4o-2024-08-06", choices: [],
        usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, prompt_tokens_details: { cached_tokens: 1024 }, completion_tokens_details: { reasoning_tokens: 0 } },
      };

      // The same call as SDK 0.6.1 sent it (normalized fields) and as SDK 0.7 sends it (raw telemetry).
      const legacy = {
        id: `legacy_${suffix}`, timestamp: startedAt, durationMs: 812.5, provider: "openai", model: "gpt-4o-2024-08-06", requestModel: "gpt-4o",
        url: "https://api.openai.com/v1/chat/completions", method: "POST", statusCode: 200,
        usage: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280, reasoningTokens: 0, cacheReadTokens: 1024, cacheCreationTokens: null },
        costUsd: null, streaming: false, streamTiming: null, providerRequestId: "chatcmpl-parity", chargeId: "chatcmpl-parity",
        callSite: { raw, frames: frames.slice(2) }, context: { feature: "summary" },
      };
      const telemetry = telemetryFor({
        url: "https://api.openai.com/v1/chat/completions", requestBody: { model: "gpt-4o", messages: [{ role: "user", content: "secret prompt" }] },
        status: 200, responseHeaders: { "x-request-id": "req_x" }, responseBody, startedAt, durationMs: 812.5,
      });
      const raw07 = {
        id: `raw_${suffix}`, timestamp: startedAt, eventType: "call",
        callSite: { raw, frames }, context: { feature: "summary" }, telemetry,
      };
      const first = await post(baseUrl, "/api/v1/events", key, { sdkVersion: "0.6.1", events: [legacy] });
      const second = await post(baseUrl, "/api/v1/events", key, { sdkVersion: "0.7.0", events: [raw07] });
      assert.equal(first.status, 202);
      assert.equal(second.status, 202, JSON.stringify(second.json));
      const rows = await pool.query(`SELECT id, ${CALL_COLUMNS} FROM events WHERE project_id = $1 AND id = ANY($2) ORDER BY id`, [projectId, [legacy.id, raw07.id]]);
      const byId = Object.fromEntries(rows.rows.map((row) => [row.id, row]));
      const before = byId[legacy.id]!;
      const after = byId[raw07.id]!;
      for (const column of ["provider", "model", "request_model", "url", "method", "status_code", "input_tokens", "output_tokens", "total_tokens",
        "reasoning_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd", "cost_basis", "cost_source", "duration_ms", "streaming",
        "charge_id", "native_units", "call_site_frames", "lifecycle_state"]) {
        assert.deepEqual(after[column], before[column], column);
      }
      // With the whole stack the server sees which frame sat next to the SDK,
      // so attribution picks the function that made the call; SDK 0.6 dropped
      // that signal client-side and the heuristic picked its caller.
      assert.equal(before.bl_function, "handler");
      assert.equal(new Date(after.timestamp).toISOString(), startedAt);
      assert.ok(after.cost_usd > 0);
      assert.equal(after.bl_function, "summarize");
      assert.ok(!String(after.call_site_raw).includes("node_modules"), "the stored raw stack is filtered too");
      assert.ok(String(before.call_site_raw).includes("node_modules"), "legacy raw stacks are stored as sent");
      assert.equal(before.raw_telemetry, null);
      assert.equal(after.raw_telemetry.v, 1, "text-capture projects keep the envelope for reprocessing");
      assert.deepEqual(after.raw_telemetry.request.body.messages[0].content, { $s: 13 });

      // Telemetry wins over legacy fields sent alongside it; the metadata-only
      // project never stores the envelope.
      const conflicting = {
        id: `wins_${suffix}`, timestamp: startedAt, provider: "anthropic", model: "made-up", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, costUsd: 99,
        telemetry: telemetryFor({ url: "https://api.openai.com/v1/chat/completions", requestBody: { model: "gpt-4o" }, status: 200, responseBody, startedAt }),
      };
      assert.equal((await post(baseUrl, "/api/v1/events", metaKey, { sdkVersion: "0.7.0", events: [conflicting] })).status, 202);
      const wins = (await pool.query(`SELECT ${CALL_COLUMNS} FROM events WHERE project_id = $1 AND id = $2`, [metaProjectId, conflicting.id])).rows[0];
      assert.deepEqual([wins.provider, wins.model, wins.input_tokens, wins.cost_usd], [before.provider, before.model, 1200, before.cost_usd]);
      assert.equal(wins.raw_telemetry, null, "metadata-only projects never store the raw envelope");

      // Streams: usage merged across chunks, timing from the stream.
      const streamed = {
        id: `stream_${suffix}`, timestamp: startedAt,
        telemetry: telemetryFor({
          url: "https://api.anthropic.com/v1/messages", requestBody: { model: "claude-haiku-4-5", stream: true, max_tokens: 64 }, status: 200,
          stream: { format: "sse", firstChunkMs: 200, records: [
            { type: "message_start", message: { id: "msg_pg", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 30, cache_read_input_tokens: 0, output_tokens: 1 } } },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 90 } },
          ] },
          startedAt, durationMs: 1_100,
        }),
      };
      // A cancelled call and a DeepSeek call with cache misses.
      const cancelled = {
        id: `cancel_${suffix}`, timestamp: startedAt,
        telemetry: telemetryFor({ url: "https://api.openai.com/v1/chat/completions", requestBody: { model: "gpt-4o", stream: true }, status: 200, stream: { format: "sse", records: [] }, error: { name: "AbortError" }, startedAt }),
      };
      const deepseek = {
        id: `ds_${suffix}`, timestamp: startedAt,
        telemetry: telemetryFor({ url: "https://api.deepseek.com/chat/completions", requestBody: { model: "deepseek-chat" }, status: 200, startedAt,
          responseBody: { id: "ds-pg", model: "deepseek-chat", usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 768, prompt_cache_miss_tokens: 232 } } }),
      };
      const batch = await post(baseUrl, "/api/v1/events", key, { sdkVersion: "0.7.0", events: [streamed, cancelled, deepseek] });
      assert.equal(batch.status, 202, JSON.stringify(batch.json));
      const more = Object.fromEntries((await pool.query(`SELECT id, ${CALL_COLUMNS} FROM events WHERE project_id = $1 AND id = ANY($2)`, [projectId, [streamed.id, cancelled.id, deepseek.id]])).rows.map((row) => [row.id, row]));
      const s = more[streamed.id]!;
      assert.deepEqual([s.model, s.request_model, s.input_tokens, s.output_tokens, s.streaming, s.ttft, s.charge_id], ["claude-haiku-4-5-20251001", "claude-haiku-4-5", 30, 90, true, 200, "msg_pg"]);
      assert.equal(s.tps, 100, "90 output tokens over the 900 ms after the first chunk");
      assert.deepEqual([more[cancelled.id]!.lifecycle_state, more[cancelled.id]!.lifecycle_error_type], ["cancelled", null]);
      assert.deepEqual([more[deepseek.id]!.cache_read_tokens, more[deepseek.id]!.cache_creation_tokens], [768, null]);
      // Legacy regression: an SDK 0.6 DeepSeek row keeps the columns it sent
      // (misses as cache creation) and prices exactly like the fixed row.
      const legacyDeepseek = {
        id: `dslegacy_${suffix}`, timestamp: startedAt, durationMs: 100, provider: "deepseek", model: "deepseek-chat",
        url: "https://api.deepseek.com/chat/completions", method: "POST", statusCode: 200,
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050, reasoningTokens: null, cacheReadTokens: 768, cacheCreationTokens: 232 },
        costUsd: null, streaming: false, streamTiming: null, callSite: null, context: {},
      };
      assert.equal((await post(baseUrl, "/api/v1/events", key, { sdkVersion: "0.6.1", events: [legacyDeepseek] })).status, 202);
      const legacyDs = (await pool.query(`SELECT ${CALL_COLUMNS} FROM events WHERE project_id = $1 AND id = $2`, [projectId, legacyDeepseek.id])).rows[0];
      assert.equal(legacyDs.cache_creation_tokens, 232);
      assert.ok(legacyDs.cost_usd > 0);
      assert.equal(legacyDs.cost_usd, more[deepseek.id]!.cost_usd);

      // LiveKit raw rows expand into one cumulative usage event per component.
      const livekit = {
        id: `lk_${suffix}`, timestamp: startedAt,
        telemetry: { v: 1, source: "livekit", livekit: { sessionId: `room_${suffix}`, revision: 3, update: skeleton({ usage: { modelUsage: [
          { type: "stt_usage", provider: "deepgram", model: "nova-3", audioDurationMs: 30_000 },
          { type: "tts_usage", provider: "cartesia", model: "sonic-2", charactersCount: 500 },
        ] } }) } },
      };
      const badLivekit = { id: `lkbad_${suffix}`, timestamp: startedAt, telemetry: { v: 1, source: "livekit", livekit: { revision: 1 } } };
      const lk = await post(baseUrl, "/api/v1/events", key, { sdkVersion: "0.7.0", events: [livekit, badLivekit] });
      assert.equal(lk.status, 202, JSON.stringify(lk.json));
      assert.equal(lk.json["accepted"], 2);
      assert.deepEqual((lk.json["rejected"] as Array<{ index: number }>).map((item) => item.index), [1]);
      const components = await pool.query(
        "SELECT component_id, unit_kind, unit_value, revision, aggregation FROM usage_components WHERE project_id = $1 ORDER BY component_id",
        [projectId],
      );
      assert.deepEqual(components.rows.map((row) => [row.component_id, row.unit_kind, Number(row.unit_value), row.revision, row.aggregation]), [
        [`livekit:room_${suffix}:stt:deepgram:nova-3`, "audio_seconds", 30, 3, "cumulative"],
        [`livekit:room_${suffix}:tts:cartesia:sonic-2`, "characters", 500, 3, "cumulative"],
      ]);

      // Lifecycle errorName is classified on the server.
      const lifecycle = await post(baseUrl, "/api/v1/events", key, { sdkVersion: "0.7.0", events: [
        { id: `lc_${suffix}`, eventType: "lifecycle", source: "explicit", entityType: "trace", entityId: `tr_${suffix}`, lifecycle: "failed", errorName: "CancelledError", timestamp: new Date().toISOString(), sequence: 1 },
      ] });
      assert.equal(lifecycle.status, 202, JSON.stringify(lifecycle.json));
      const trace = (await pool.query("SELECT state, error_type FROM traces WHERE project_id = $1 AND id = $2", [projectId, `tr_${suffix}`])).rows[0];
      assert.deepEqual([trace.state, trace.error_type], ["cancelled", null]);

      // Python call graph: raw upload scored on the server; sdkVersion stored.
      const graph = await post(baseUrl, `/api/v1/projects/${projectId}/callgraph`, key, {
        sdkVersion: "python-0.7.0",
        functions: {
          "app/llm.py:ask": { line: 4, callees: [], callExpressions: ["client.messages.create"] },
          "app/views.py:index": { line: 9, callees: ["app/llm.py:ask"], callExpressions: ["ask"] },
        },
      });
      assert.equal(graph.status, 200);
      const stored = (await pool.query("SELECT graph_data, sdk_version FROM call_graphs WHERE project_id = $1", [projectId])).rows[0];
      assert.equal(stored.sdk_version, "python-0.7.0");
      assert.deepEqual(stored.graph_data["app/views.py:index"], { line: 9, score: -15, fan_in: 0, calls_ai: false });
      const legacyGraph = await post(baseUrl, `/api/v1/projects/${projectId}/callgraph`, key, {
        sdk_version: "python-0.6.1", functions: { "a.py:f": { line: 1, score: 5, fan_in: 0, calls_ai: true } },
      });
      assert.equal(legacyGraph.status, 200);
      const legacyStored = (await pool.query("SELECT graph_data, sdk_version FROM call_graphs WHERE project_id = $1", [projectId])).rows[0];
      assert.deepEqual([legacyStored.sdk_version, legacyStored.graph_data["a.py:f"].score], ["python-0.6.1", 5]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    for (const id of [projectId, metaProjectId]) {
      for (const table of ["events", "usage_components", "call_site_stats", "frame_stats", "frame_stats_callsites", "call_graphs", "traces", "executions", "groups", "project_settings"]) {
        await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [id]).catch(() => undefined);
      }
      await pool.query("DELETE FROM projects WHERE id = $1", [id]).catch(() => undefined);
    }
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});
