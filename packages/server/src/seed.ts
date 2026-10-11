import type pg from "pg";
import bcrypt from "bcryptjs";
import { projectDsn } from "./public-url.js";

export async function seedIfEmpty(pool: pg.Pool): Promise<void> {
  const result = await pool.query("SELECT COUNT(*)::int as count FROM projects");
  if (result.rows[0].count > 0) return;

  console.log("[costkey] Seeding demo data...");

  const orgId = "org_demo";
  const projectId = "proj_demo";
  const authKey = "ck_demo_key";
  const passwordHash = await bcrypt.hash("demo1234", 10);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query("INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [orgId, "ACME Corp", "acme"]);
    await client.query(
      "INSERT INTO users (id, email, password_hash, name, org_id, role) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      ["usr_demo", "demo@costkey.dev", passwordHash, "Demo User", orgId, "owner"],
    );
    await client.query(
      "INSERT INTO projects (id, name, org_id, auth_key) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [projectId, "ACME Corp", orgId, authKey],
    );

    // Call chains for realistic data
    const chains = [
      { leaf: ["src/features/search/summarizer.ts", "summarizeDocument", 47], stack: [["src/features/search/summarizer.ts","summarizeDocument",47],["src/features/search/pipeline.ts","processSearchResults",23],["src/api/routes/search.ts","handleSearchRequest",15]] },
      { leaf: ["src/features/search/reranker.ts", "rerankResults", 92], stack: [["src/features/search/reranker.ts","rerankResults",92],["src/features/search/pipeline.ts","processSearchResults",31],["src/api/routes/search.ts","handleSearchRequest",15]] },
      { leaf: ["src/api/middleware/classify.ts", "classifyIntent", 8], stack: [["src/api/middleware/classify.ts","classifyIntent",8],["src/api/routes/search.ts","handleSearchRequest",12]] },
      { leaf: ["src/features/chat/handler.ts", "generateChatResponse", 23], stack: [["src/features/chat/handler.ts","generateChatResponse",23],["src/features/chat/stream.ts","streamChat",45],["src/api/routes/chat.ts","handleChatMessage",18]] },
      { leaf: ["src/features/chat/titles.ts", "generateConversationTitle", 12], stack: [["src/features/chat/titles.ts","generateConversationTitle",12],["src/features/chat/handler.ts","generateChatResponse",58],["src/api/routes/chat.ts","handleChatMessage",18]] },
      { leaf: ["src/features/email/summarizer.ts", "generateEmailSummary", 34], stack: [["src/features/email/summarizer.ts","generateEmailSummary",34],["src/features/email/processor.ts","processInboxEmails",67],["src/jobs/email-digest.ts","runEmailDigest",22]] },
      { leaf: ["src/features/email/classifier.ts", "classifyEmailPriority", 19], stack: [["src/features/email/classifier.ts","classifyEmailPriority",19],["src/features/email/processor.ts","processInboxEmails",43],["src/jobs/email-digest.ts","runEmailDigest",22]] },
      { leaf: ["src/jobs/nightly-analysis.ts", "analyzeUserBehavior", 156], stack: [["src/jobs/nightly-analysis.ts","analyzeUserBehavior",156],["src/jobs/nightly-analysis.ts","runNightlyAnalysis",12],["src/jobs/scheduler.ts","executeCronJob",88]] },
      { leaf: ["src/api/middleware/moderate.ts", "moderateContent", 14], stack: [["src/api/middleware/moderate.ts","moderateContent",14],["src/api/middleware/index.ts","runMiddlewareChain",34],["src/api/routes/chat.ts","handleChatMessage",10]] },
    ];

    const models = [
      { model: "gpt-4o", provider: "openai", inp: 2.5, out: 10 },
      { model: "gpt-4o-mini", provider: "openai", inp: 0.15, out: 0.6 },
      { model: "claude-sonnet-4-0-20250514", provider: "anthropic", inp: 3, out: 15 },
      { model: "claude-haiku-3-5-20241022", provider: "anthropic", inp: 0.8, out: 4 },
      { model: "gemini-2.0-flash", provider: "google", inp: 0.1, out: 0.4 },
    ];

    const traceTemplates = [
      { name: "GET /api/search", idxs: [0, 1, 2] },
      { name: "GET /api/search", idxs: [0, 2] },
      { name: "POST /api/chat", idxs: [3, 4, 8] },
      { name: "POST /api/chat", idxs: [3, 8] },
      { name: "CRON email-digest", idxs: [5, 6] },
      { name: "CRON nightly-analysis", idxs: [7] },
    ];

    const releases = ["v1.2.0", "v1.2.1", "v1.3.0", "v1.3.1", "v1.4.0"];

    const now = Date.now();
    const DAY = 86400000;
    let eventCount = 0;

    for (let d = 29; d >= 0; d--) {
      const dayBase = now - d * DAY;
      // More calls on recent days, fewer on older days
      const baseTraces = d < 7 ? 50 : d < 14 ? 35 : 20;
      const tracesPerDay = baseTraces + Math.floor(Math.random() * 20);
      const release = releases[Math.min(Math.floor((29 - d) / 6), releases.length - 1)];

      for (let i = 0; i < tracesPerDay; i++) {
        const tmpl = traceTemplates[Math.floor(Math.random() * traceTemplates.length)];
        const traceId = `tr_${Math.random().toString(36).slice(2, 12)}`;
        // Spread each day's runs over the 24 hours ending at dayBase so the
        // newest demo runs are never timestamped in the future.
        const baseTs = dayBase - Math.floor(Math.random() * DAY);

        for (let j = 0; j < tmpl.idxs.length; j++) {
          const chain = chains[tmpl.idxs[j]];
          const m = models[Math.floor(Math.random() * models.length)];
          const ts = new Date(baseTs + j * (100 + Math.random() * 2000)).toISOString();
          const inputTokens = 100 + Math.floor(Math.random() * 3000);
          const outputTokens = 50 + Math.floor(Math.random() * 1500);
          const costUsd = (inputTokens / 1e6) * m.inp + (outputTokens / 1e6) * m.out;
          const durationMs = 200 + Math.random() * 3000;
          const streaming = Math.random() > 0.4;
          const ttft = streaming ? 50 + Math.random() * 500 : null;
          const tps = streaming ? 20 + Math.random() * 80 : null;
          const eventId = `evt_${Math.random().toString(36).slice(2, 12)}`;
          const [file, fn, line] = chain.leaf;
          const csKey = `${file}:${fn}:${line}`;
          const frames = JSON.stringify(chain.stack.map(([f, func, l]: any) => ({ fileName: f, functionName: func, lineNumber: l, columnNumber: 12 })));
          const rawStack = chain.stack.map(([f, func, l]: any) => `    at ${func} (${f}:${l}:12)`).join("\n");
          const url = m.provider === "openai" ? "https://api.openai.com/v1/chat/completions" : m.provider === "anthropic" ? "https://api.anthropic.com/v1/messages" : "https://generativelanguage.googleapis.com/v1/models/gemini:generateContent";

          await client.query(
            `INSERT INTO events (id, timestamp, project_id, provider, model, url, method, status_code,
              input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, streaming, ttft, tps,
              trace_id, trace_name, call_site_raw, call_site_frames, context, release)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
            [eventId, ts, projectId, m.provider, m.model, url, "POST", 200,
              inputTokens, outputTokens, inputTokens + outputTokens,
              Math.round(costUsd * 1e6) / 1e6, Math.round(durationMs * 100) / 100,
              streaming, ttft ? Math.round(ttft * 100) / 100 : null,
              tps ? Math.round(tps * 100) / 100 : null,
              traceId, tmpl.name, rawStack, frames,
              JSON.stringify({ task: fn, traceId, traceName: tmpl.name }), release],
          );

          await client.query(
            `INSERT INTO call_site_stats (project_id, call_site_key, file_name, function_name, line_number,
              provider, model, total_calls, total_cost_usd, total_input_tokens, total_output_tokens,
              avg_duration_ms, avg_ttft, avg_tps, first_seen, last_seen)
            VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$14)
            ON CONFLICT (project_id, call_site_key, model) DO UPDATE SET
              total_calls = call_site_stats.total_calls + 1,
              total_cost_usd = call_site_stats.total_cost_usd + EXCLUDED.total_cost_usd,
              total_input_tokens = call_site_stats.total_input_tokens + EXCLUDED.total_input_tokens,
              total_output_tokens = call_site_stats.total_output_tokens + EXCLUDED.total_output_tokens,
              last_seen = EXCLUDED.last_seen`,
            [projectId, csKey, file, fn, line, m.provider, m.model,
              Math.round(costUsd * 1e6) / 1e6, inputTokens, outputTokens,
              Math.round(durationMs * 100) / 100,
              ttft ? Math.round(ttft * 100) / 100 : null,
              tps ? Math.round(tps * 100) / 100 : null, ts],
          );

          eventCount++;
        }
      }
    }

    await client.query("COMMIT");
    console.log(`[costkey] Seeded ${eventCount} events for ACME Corp (demo@costkey.dev / demo1234)`);
    console.log(`[costkey] Demo DSN: ${projectDsn(authKey, projectId)}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

interface DemoAgent {
  name: string;
  tools: Array<{ name: string; minMs: number; maxMs: number }>;
  models: Array<{ model: string; provider: string; inp: number; out: number; cache: "anthropic" | "openai" | null; minMs: number; maxMs: number }>;
  quality: number;
}

const DEMO_AGENTS: DemoAgent[] = [
  {
    name: "support-agent",
    tools: [{ name: "search_docs", minMs: 120, maxMs: 900 }, { name: "lookup_order", minMs: 60, maxMs: 400 }],
    models: [
      { model: "claude-sonnet-4-0-20250514", provider: "anthropic", inp: 3, out: 15, cache: "anthropic", minMs: 1200, maxMs: 5200 },
      { model: "claude-haiku-3-5-20241022", provider: "anthropic", inp: 0.8, out: 4, cache: "anthropic", minMs: 500, maxMs: 1800 },
    ],
    quality: 0.88,
  },
  {
    name: "research-agent",
    tools: [{ name: "web_search", minMs: 500, maxMs: 2600 }, { name: "fetch_page", minMs: 200, maxMs: 1500 }],
    models: [
      { model: "gpt-4o", provider: "openai", inp: 2.5, out: 10, cache: "openai", minMs: 1500, maxMs: 6500 },
      { model: "gpt-4o-mini", provider: "openai", inp: 0.15, out: 0.6, cache: "openai", minMs: 400, maxMs: 1600 },
    ],
    quality: 0.79,
  },
  {
    name: "triage-agent",
    tools: [{ name: "classify_ticket", minMs: 40, maxMs: 250 }],
    models: [{ model: "gemini-2.0-flash", provider: "google", inp: 0.1, out: 0.4, cache: null, minMs: 300, maxMs: 1200 }],
    quality: 0.93,
  },
];

async function insertRows(client: pg.PoolClient, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  for (let start = 0; start < rows.length; start += 200) {
    const chunk = rows.slice(start, start + 200);
    const params: unknown[] = [];
    const values = chunk.map((row) => `(${row.map((value) => { params.push(value); return `$${params.length}`; }).join(",")})`);
    await client.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${values.join(",")} ON CONFLICT DO NOTHING`, params);
  }
}

/**
 * Demo agent runs for the Overview board: agent root spans, tool spans, model
 * calls with cache tokens, and judge/code scores over the last 30 days. Runs
 * once per demo project (dev only), including demo databases seeded before
 * agents existed.
 */
export async function seedDemoAgentRuns(pool: pg.Pool, projectId = "proj_demo"): Promise<void> {
  const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [projectId]);
  if (project.rowCount === 0) return;
  const seeded = await pool.query("SELECT 1 FROM spans WHERE project_id = $1 AND id LIKE 'sp_demo_%' LIMIT 1", [projectId]);
  if ((seeded.rowCount ?? 0) > 0) return;

  const random = (min: number, max: number) => min + Math.random() * (max - min);
  const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
  const id = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 12)}`;
  const iso = (ms: number) => new Date(ms).toISOString();
  const clamp = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
  const now = Date.now();
  const DAY = 86_400_000;
  const events: unknown[][] = [];
  const spans: unknown[][] = [];
  const scores: unknown[][] = [];

  for (let d = 29; d >= 0; d--) {
    const dayBase = now - d * DAY;
    for (const agent of DEMO_AGENTS) {
      const runCount = Math.floor(d < 7 ? random(6, 11) : d < 14 ? random(4, 8) : random(2, 6));
      for (let i = 0; i < runCount; i++) {
        const traceId = id("tr_demo_");
        const rootId = id("sp_demo_");
        // Leave a minute of room so no demo run ends in the future.
        const start = dayBase - 60_000 - Math.floor(Math.random() * (DAY - 120_000));
        const failed = Math.random() < 0.05;
        const turns = 2 + Math.floor(Math.random() * 3);
        let cursor = start + Math.floor(random(20, 120));
        for (let turn = 0; turn < turns; turn++) {
          const m = turn === turns - 1 && agent.models.length > 1 ? agent.models[1] : agent.models[0];
          const durationMs = Math.round(random(m.minMs, m.maxMs));
          const inputTokens = Math.floor(random(800, 6000)) + turn * 900;
          const outputTokens = Math.floor(random(80, 900));
          const cacheRead = m.cache && turn > 0 ? Math.floor(inputTokens * random(0.3, 0.75)) : null;
          const cacheWrite = m.cache === "anthropic" && turn === 0 ? Math.floor(random(600, 2400)) : null;
          // Anthropic reads/writes cache beside input; OpenAI cached tokens are part of input.
          const cost = m.cache === "openai"
            ? ((inputTokens - (cacheRead ?? 0)) * m.inp + (cacheRead ?? 0) * m.inp * 0.5 + outputTokens * m.out) / 1e6
            : (inputTokens * m.inp + (cacheRead ?? 0) * m.inp * 0.1 + (cacheWrite ?? 0) * m.inp * 1.25 + outputTokens * m.out) / 1e6;
          events.push([
            id("evt_demo_"), iso(cursor), projectId, m.provider, m.model, "POST", 200,
            inputTokens, outputTokens, inputTokens + outputTokens, cacheRead, cacheWrite,
            Math.round(cost * 1e6) / 1e6, durationMs, false, traceId, agent.name, rootId,
            JSON.stringify({ agent: agent.name, task: agent.name, traceId, traceName: agent.name }),
          ]);
          cursor += durationMs + Math.floor(random(10, 60));
          if (turn < turns - 1) {
            const tool = pick(agent.tools);
            const toolMs = Math.round(random(tool.minMs, tool.maxMs));
            const toolFailed = failed && turn === turns - 2;
            spans.push([id("sp_demo_"), projectId, traceId, rootId, "tool", tool.name, toolFailed ? "error" : "ok", toolFailed ? "ToolError" : null, iso(cursor), iso(cursor + toolMs), JSON.stringify({ agent: agent.name })]);
            cursor += toolMs + Math.floor(random(10, 60));
          }
        }
        spans.push([rootId, projectId, traceId, null, "agent", agent.name, failed ? "error" : "ok", failed ? "ToolError" : null, iso(start), iso(cursor), JSON.stringify({ agent: agent.name })]);
        const scoredAt = iso(cursor + Math.floor(random(800, 3000)));
        const penalty = failed ? 0.35 : 0;
        scores.push([projectId, id("sc_demo_"), traceId, rootId, "faithfulness", clamp(agent.quality - penalty + random(-0.12, 0.08)), null, "judge", scoredAt]);
        scores.push([projectId, id("sc_demo_"), traceId, rootId, "helpfulness", clamp(agent.quality - 0.04 - penalty + random(-0.12, 0.1)), null, "judge", scoredAt]);
        if (agent.name === "support-agent") {
          const answered = !failed && Math.random() < 0.93;
          scores.push([projectId, id("sc_demo_"), traceId, rootId, "answered", answered ? 1 : 0, answered ? "pass" : "fail", "code", scoredAt]);
        }
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertRows(client, "events", [
      "id", "timestamp", "project_id", "provider", "model", "method", "status_code",
      "input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_creation_tokens",
      "cost_usd", "duration_ms", "streaming", "trace_id", "trace_name", "span_id", "context",
    ], events);
    await insertRows(client, "spans", [
      "id", "project_id", "trace_id", "parent_span_id", "kind", "name", "status", "error_type", "started_at", "ended_at", "attributes",
    ], spans);
    await insertRows(client, "scores", ["project_id", "id", "trace_id", "span_id", "name", "value", "label", "source", "timestamp"], scores);
    await client.query("COMMIT");
    console.log(`[costkey] Seeded ${spans.length} demo agent spans, ${events.length} calls and ${scores.length} scores`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
