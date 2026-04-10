import type pg from "pg";
import bcrypt from "bcryptjs";

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
        const baseTs = dayBase + Math.floor(Math.random() * DAY);

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
    console.log(`[costkey] Demo DSN: https://${authKey}@localhost:4100/${projectId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
