import { createHash } from "node:crypto";
import type pg from "pg";
import { recordInternalEvents } from "./internal-events.js";
import { evaluateRule, loadRunFacts } from "./rules.js";
import { sampleBucket } from "./sampling.js";
import { createCheck, parseCheckInput, scoreIdFor, type QualityCheck } from "./store.js";
import { checkWantsRun, projectCapture, upsertCheckScore, QUALITY_CHECKS_FEATURE } from "./worker.js";

/**
 * Demo quality checks for the local demo (COSTKEY_SEED_DEMO only): two rule
 * checks evaluated for real over recent demo runs, and two template judges
 * with canned verdicts, since the demo has no provider key.
 */

const DEMO_REASONS = {
  pass: [
    "The answer addresses the request directly and completely.",
    "It answers the question and cites what the tools returned.",
    "Clear, complete answer to what the user asked.",
  ],
  fail: [
    "The answer drifts to a related topic and never answers the question.",
    "It asks the user to try again instead of answering.",
    "Only half of the request is answered.",
  ],
  toolPass: [
    "Searched once, then fetched the right page. No wasted calls.",
    "The tools and arguments fit the request.",
  ],
  toolFail: [
    "Fetched the same page twice and skipped the search it needed.",
    "Called search with an empty query before recovering.",
  ],
};

function pick<T>(items: T[], seed: string): T {
  const index = Number.parseInt(createHash("md5").update(seed).digest("hex").slice(0, 6), 16) % items.length;
  return items[index];
}

async function markDone(pool: pg.Pool, check: QualityCheck, traceId: string, status: "done" | "skipped", fields: { scoreId?: string; skipReason?: string; detail?: string }): Promise<void> {
  await pool.query(
    `INSERT INTO quality_check_jobs (project_id, check_id, trace_id, origin, status, attempts, score_id, skip_reason, last_error, completed_at)
     VALUES ($1, $2, $3, 'backfill', $4, 1, $5, $6, $7, NOW())
     ON CONFLICT (check_id, trace_id) DO NOTHING`,
    [check.projectId, check.id, traceId, status, fields.scoreId ?? null, fields.skipReason ?? null, fields.detail ?? null],
  );
}

export async function seedDemoQualityChecks(pool: pg.Pool, projectId = "proj_demo"): Promise<void> {
  const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [projectId]);
  if (project.rowCount === 0) return;
  const existing = await pool.query("SELECT 1 FROM quality_checks WHERE project_id = $1 LIMIT 1", [projectId]);
  if ((existing.rowCount ?? 0) > 0) return;

  const runSucceeded = await createCheck(pool, projectId, parseCheckInput({ kind: "rule", rule: "run_succeeded" }), null);
  const latency = await createCheck(pool, projectId, parseCheckInput({ kind: "rule", rule: "latency", name: "Latency under 20s", target: 20 }), null);
  const answered = await createCheck(pool, projectId, parseCheckInput({ kind: "judge", template: "answered", judgeProvider: "openai", sampleRate: 50 }), null);
  const toolChoice = await createCheck(pool, projectId, parseCheckInput({
    kind: "judge", template: "tool_choice", judgeProvider: "anthropic", appliesTo: "named", appliesToNames: ["research-agent"],
  }), null);

  const runs = await pool.query(
    `SELECT trace_id FROM events
     WHERE project_id = $1 AND trace_id IS NOT NULL AND COALESCE(event_type, 'call') = 'call'
     GROUP BY trace_id ORDER BY MAX(timestamp) DESC LIMIT 200`,
    [projectId],
  );
  const capture = await projectCapture(pool, projectId);
  const usage: Array<Record<string, unknown>> = [];
  let scored = 0;
  for (const { trace_id: traceId } of runs.rows as Array<{ trace_id: string }>) {
    const facts = await loadRunFacts(pool, projectId, traceId);
    if (!facts) continue;
    for (const check of [runSucceeded, latency]) {
      const outcome = evaluateRule(check.rule!, facts, check.target);
      if (outcome.kind === "skip") { await markDone(pool, check, traceId, "skipped", { skipReason: outcome.reason, detail: outcome.detail }); continue; }
      const scoreId = await upsertCheckScore(pool, check, facts, outcome, capture);
      await markDone(pool, check, traceId, "done", { scoreId });
      scored += 1;
    }
    for (const check of [answered, toolChoice]) {
      if (checkWantsRun(check, facts) !== "yes") continue;
      if (!capture.textCapture) { await markDone(pool, check, traceId, "skipped", { skipReason: "needs_capture" }); continue; }
      const bucket = sampleBucket(`${check.id}:${traceId}`);
      const failing = facts.failedSpans > 0 ? bucket < 70 : bucket < 12;
      const value = failing ? Math.round((0.1 + (bucket % 30) / 100) * 100) / 100 : Math.round((0.75 + (bucket % 25) / 100) * 100) / 100;
      const reasons = check.id === toolChoice.id
        ? (failing ? DEMO_REASONS.toolFail : DEMO_REASONS.toolPass)
        : (failing ? DEMO_REASONS.fail : DEMO_REASONS.pass);
      const scoreId = await upsertCheckScore(pool, check, facts, { value, label: failing ? "fail" : "pass", reason: pick(reasons, traceId) }, capture);
      await markDone(pool, check, traceId, "done", { scoreId });
      scored += 1;
      const endedAt = facts.endedAt ? Date.parse(facts.endedAt) : Date.now();
      if (Date.now() - endedAt < 6 * 86_400_000 && usage.length < 200) {
        const input = 900 + Math.round(bucket * 20);
        usage.push({
          id: `qcj_demo_${createHash("sha256").update(scoreIdFor(check.id, traceId)).digest("hex").slice(0, 24)}`,
          eventType: "call",
          timestamp: new Date(endedAt + 5_000).toISOString(),
          provider: check.judgeProvider,
          model: check.judgeModel,
          url: check.judgeProvider === "anthropic" ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/chat/completions",
          method: "POST",
          statusCode: 200,
          durationMs: 900 + Math.round(bucket * 10),
          streaming: false,
          usage: { inputTokens: input, outputTokens: 60, totalTokens: input + 60 },
          context: { feature: QUALITY_CHECKS_FEATURE, operation: check.name },
        });
      }
    }
  }
  if (usage.length > 0) await recordInternalEvents(pool, projectId, usage);
  console.log(`[costkey] Seeded 4 demo quality checks with ${scored} results`);
}
