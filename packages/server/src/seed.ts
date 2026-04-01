import type Database from "better-sqlite3";

/**
 * Seed the database with a demo project and realistic multi-frame stack traces
 * so the call chain grouping engine has something meaningful to work with.
 */
export function seedIfEmpty(db: Database.Database): void {
  const projectCount = db.prepare("SELECT COUNT(*) as count FROM projects").get() as { count: number };
  if (projectCount.count > 0) return;

  console.log("[costkey] Seeding demo data...");

  // Create demo org, user, and project
  const orgId = "org_demo";
  const projectId = "proj_demo";
  const authKey = "ck_demo_key";

  db.prepare("INSERT OR IGNORE INTO orgs (id, name, slug) VALUES (?, ?, ?)").run(orgId, "Demo Org", "demo");
  // Password: "demo1234"
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, name, org_id, role) VALUES (?, ?, ?, ?, ?, ?)").run(
    "usr_demo", "demo@costkey.dev",
    "$2a$10$xJ8Dq5z5z5z5z5z5z5z5zON7QV7QV7QV7QV7QV7QV7QV7QV7QV7QV",
    "Demo User", orgId, "owner",
  );
  db.prepare("INSERT INTO projects (id, name, org_id, auth_key) VALUES (?, ?, ?, ?)").run(
    projectId, "Demo App", orgId, authKey,
  );

  // Realistic call chains — each entry is a leaf function with its full stack trace
  // This is what the SDK would capture: the AI call site + every parent frame
  const callChains = [
    // ── Search Pipeline ──
    // User searches → processResults → summarizeDocument (AI call)
    {
      leaf: { file: "src/features/search/summarizer.ts", fn: "summarizeDocument", line: 47 },
      stack: [
        { file: "src/features/search/summarizer.ts", fn: "summarizeDocument", line: 47 },
        { file: "src/features/search/pipeline.ts", fn: "processSearchResults", line: 23 },
        { file: "src/api/routes/search.ts", fn: "handleSearchRequest", line: 15 },
      ],
    },
    // User searches → processResults → rerankResults (AI call)
    {
      leaf: { file: "src/features/search/reranker.ts", fn: "rerankResults", line: 92 },
      stack: [
        { file: "src/features/search/reranker.ts", fn: "rerankResults", line: 92 },
        { file: "src/features/search/pipeline.ts", fn: "processSearchResults", line: 31 },
        { file: "src/api/routes/search.ts", fn: "handleSearchRequest", line: 15 },
      ],
    },
    // User searches → classifyIntent (AI call, from middleware)
    {
      leaf: { file: "src/api/middleware/classify.ts", fn: "classifyIntent", line: 8 },
      stack: [
        { file: "src/api/middleware/classify.ts", fn: "classifyIntent", line: 8 },
        { file: "src/api/routes/search.ts", fn: "handleSearchRequest", line: 12 },
      ],
    },

    // ── Chat Feature ──
    // User chats → generateChatResponse (AI call)
    {
      leaf: { file: "src/features/chat/handler.ts", fn: "generateChatResponse", line: 23 },
      stack: [
        { file: "src/features/chat/handler.ts", fn: "generateChatResponse", line: 23 },
        { file: "src/features/chat/stream.ts", fn: "streamChat", line: 45 },
        { file: "src/api/routes/chat.ts", fn: "handleChatMessage", line: 18 },
      ],
    },
    // Chat → generateTitle for conversation
    {
      leaf: { file: "src/features/chat/titles.ts", fn: "generateConversationTitle", line: 12 },
      stack: [
        { file: "src/features/chat/titles.ts", fn: "generateConversationTitle", line: 12 },
        { file: "src/features/chat/handler.ts", fn: "generateChatResponse", line: 58 },
        { file: "src/features/chat/stream.ts", fn: "streamChat", line: 45 },
        { file: "src/api/routes/chat.ts", fn: "handleChatMessage", line: 18 },
      ],
    },

    // ── Email Feature ──
    // Cron → processEmails → generateEmailSummary (AI call)
    {
      leaf: { file: "src/features/email/summarizer.ts", fn: "generateEmailSummary", line: 34 },
      stack: [
        { file: "src/features/email/summarizer.ts", fn: "generateEmailSummary", line: 34 },
        { file: "src/features/email/processor.ts", fn: "processInboxEmails", line: 67 },
        { file: "src/jobs/email-digest.ts", fn: "runEmailDigest", line: 22 },
      ],
    },
    // Cron → processEmails → classifyEmail (AI call)
    {
      leaf: { file: "src/features/email/classifier.ts", fn: "classifyEmailPriority", line: 19 },
      stack: [
        { file: "src/features/email/classifier.ts", fn: "classifyEmailPriority", line: 19 },
        { file: "src/features/email/processor.ts", fn: "processInboxEmails", line: 43 },
        { file: "src/jobs/email-digest.ts", fn: "runEmailDigest", line: 22 },
      ],
    },

    // ── Nightly Analysis (standalone job) ──
    {
      leaf: { file: "src/jobs/nightly-analysis.ts", fn: "analyzeUserBehavior", line: 156 },
      stack: [
        { file: "src/jobs/nightly-analysis.ts", fn: "analyzeUserBehavior", line: 156 },
        { file: "src/jobs/nightly-analysis.ts", fn: "runNightlyAnalysis", line: 12 },
        { file: "src/jobs/scheduler.ts", fn: "executeCronJob", line: 88 },
      ],
    },

    // ── Content Moderation (API middleware) ──
    {
      leaf: { file: "src/api/middleware/moderate.ts", fn: "moderateContent", line: 14 },
      stack: [
        { file: "src/api/middleware/moderate.ts", fn: "moderateContent", line: 14 },
        { file: "src/api/middleware/index.ts", fn: "runMiddlewareChain", line: 34 },
        { file: "src/api/routes/chat.ts", fn: "handleChatMessage", line: 10 },
      ],
    },
  ];

  const models = [
    { model: "gpt-4o", provider: "openai", inputCostPer1M: 2.5, outputCostPer1M: 10 },
    { model: "gpt-4o-mini", provider: "openai", inputCostPer1M: 0.15, outputCostPer1M: 0.6 },
    { model: "claude-sonnet-4-0-20250514", provider: "anthropic", inputCostPer1M: 3, outputCostPer1M: 15 },
    { model: "claude-haiku-3-5-20241022", provider: "anthropic", inputCostPer1M: 0.8, outputCostPer1M: 4 },
    { model: "gemini-2.0-flash", provider: "google", inputCostPer1M: 0.1, outputCostPer1M: 0.4 },
  ];

  // Weight certain call chains more heavily (search is the hot path)
  const weights: Record<string, number> = {
    "summarizeDocument": 25,
    "rerankResults": 20,
    "classifyIntent": 30,
    "generateChatResponse": 15,
    "generateConversationTitle": 10,
    "generateEmailSummary": 5,
    "classifyEmailPriority": 8,
    "analyzeUserBehavior": 2,
    "moderateContent": 20,
  };

  // Trace templates — each trace is a "request" that triggers multiple AI calls
  const traceTemplates = [
    { name: "GET /api/search", chains: [0, 1, 2] },      // search: classify + summarize + rerank
    { name: "GET /api/search", chains: [0, 2] },          // search: sometimes just summarize + classify
    { name: "POST /api/chat", chains: [3, 4, 8] },        // chat: response + title + moderation
    { name: "POST /api/chat", chains: [3, 8] },            // chat: response + moderation (no title)
    { name: "CRON email-digest", chains: [5, 6] },         // email: summarize + classify
    { name: "CRON nightly-analysis", chains: [7] },         // analysis: standalone
  ];

  const insertEvent = db.prepare(`
    INSERT INTO events (
      id, timestamp, project_id, provider, model, url, method, status_code,
      input_tokens, output_tokens, total_tokens,
      cost_usd, duration_ms, streaming,
      ttft, tps,
      trace_id, trace_name,
      call_site_raw, call_site_frames, context
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertCallSite = db.prepare(`
    INSERT INTO call_site_stats (
      project_id, call_site_key, file_name, function_name, line_number,
      provider, model,
      total_calls, total_cost_usd, total_input_tokens, total_output_tokens,
      avg_duration_ms, avg_ttft, avg_tps,
      first_seen, last_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, call_site_key, model) DO UPDATE SET
      total_calls = total_calls + excluded.total_calls,
      total_cost_usd = total_cost_usd + excluded.total_cost_usd,
      total_input_tokens = total_input_tokens + excluded.total_input_tokens,
      total_output_tokens = total_output_tokens + excluded.total_output_tokens,
      avg_duration_ms = (avg_duration_ms + excluded.avg_duration_ms) / 2,
      avg_ttft = COALESCE((avg_ttft + excluded.avg_ttft) / 2, excluded.avg_ttft),
      avg_tps = COALESCE((avg_tps + excluded.avg_tps) / 2, excluded.avg_tps),
      last_seen = excluded.last_seen
  `);

  const now = Date.now();
  const DAY = 86400000;

  function genId(): string {
    return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }

  function insertOneEvent(
    chain: typeof callChains[0],
    m: typeof models[0],
    ts: string,
    traceId: string | null,
    traceName: string | null,
  ) {
    const inputTokens = 100 + Math.floor(Math.random() * 3000);
    const outputTokens = 50 + Math.floor(Math.random() * 1500);
    const totalTokens = inputTokens + outputTokens;
    const costUsd =
      (inputTokens / 1_000_000) * m.inputCostPer1M +
      (outputTokens / 1_000_000) * m.outputCostPer1M;
    const durationMs = 200 + Math.random() * 3000;
    const streaming = Math.random() > 0.4;
    const ttft = streaming ? 50 + Math.random() * 500 : null;
    const tps = streaming ? 20 + Math.random() * 80 : null;

    const eventId = `evt_${genId()}`;
    const leaf = chain.leaf;
    const callSiteKey = `${leaf.file}:${leaf.fn}:${leaf.line}`;

    const frames = JSON.stringify(
      chain.stack.map((f) => ({
        fileName: f.file,
        functionName: f.fn,
        lineNumber: f.line,
        columnNumber: 12,
      })),
    );

    const rawStack = chain.stack
      .map((f) => `    at ${f.fn} (${f.file}:${f.line}:12)`)
      .join("\n");

    const context = JSON.stringify({
      task: leaf.fn,
      traceId,
      traceName,
    });

    const url =
      m.provider === "openai"
        ? "https://api.openai.com/v1/chat/completions"
        : m.provider === "anthropic"
          ? "https://api.anthropic.com/v1/messages"
          : "https://generativelanguage.googleapis.com/v1/models/gemini:generateContent";

    insertEvent.run(
      eventId, ts, projectId, m.provider, m.model, url, "POST", 200,
      inputTokens, outputTokens, totalTokens,
      Math.round(costUsd * 1_000_000) / 1_000_000, Math.round(durationMs * 100) / 100,
      streaming ? 1 : 0,
      ttft ? Math.round(ttft * 100) / 100 : null,
      tps ? Math.round(tps * 100) / 100 : null,
      traceId, traceName,
      rawStack, frames, context,
    );

    upsertCallSite.run(
      projectId, callSiteKey, leaf.file, leaf.fn, leaf.line,
      m.provider, m.model,
      1, Math.round(costUsd * 1_000_000) / 1_000_000,
      inputTokens, outputTokens,
      Math.round(durationMs * 100) / 100,
      ttft ? Math.round(ttft * 100) / 100 : null,
      tps ? Math.round(tps * 100) / 100 : null,
      ts, ts,
    );
  }

  const insertAll = db.transaction(() => {
    for (let d = 6; d >= 0; d--) {
      const dayBase = now - d * DAY;
      const tracesPerDay = 40 + Math.floor(Math.random() * 30);

      for (let i = 0; i < tracesPerDay; i++) {
        // Pick a random trace template
        const template = traceTemplates[Math.floor(Math.random() * traceTemplates.length)];
        const traceId = `tr_${genId()}`;
        const baseTs = dayBase + Math.floor(Math.random() * DAY);

        // Generate events for each call in the trace, slightly offset in time
        for (let j = 0; j < template.chains.length; j++) {
          const chain = callChains[template.chains[j]];
          const m = models[Math.floor(Math.random() * models.length)];
          // Each call in a trace happens slightly after the previous
          const ts = new Date(baseTs + j * (100 + Math.random() * 2000)).toISOString();
          insertOneEvent(chain, m, ts, traceId, template.name);
        }
      }
    }
  });

  insertAll();

  const eventCount = db.prepare("SELECT COUNT(*) as count FROM events").get() as { count: number };
  console.log(`[costkey] Seeded ${eventCount.count} events for demo project`);
  console.log(`[costkey] Demo DSN: https://${authKey}@localhost:4100/${projectId}`);
}
