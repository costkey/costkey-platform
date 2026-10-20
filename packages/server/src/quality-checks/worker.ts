import { createHash } from "node:crypto";
import type pg from "pg";
import { recordAccountingEvent } from "../accounting.js";
import { redactCapturedContent } from "../privacy.js";
import { callJudge, JudgeProviderError, type JudgeCall, type JudgeEndpoints } from "./judge.js";
import { recordInternalEvents } from "./internal-events.js";
import { checkAppliesToRun, evaluateRule, loadRunFacts, type RunFacts } from "./rules.js";
import { isSampled, sampleBucketSql } from "./sampling.js";
import { getCheck, listChecks, openJudgeKey, scoreIdFor, type QualityCheck } from "./store.js";
import { formatTranscript, loadRunTranscript } from "./transcript.js";

/**
 * The quality check worker.
 *
 * 1. Scan: each tick reads traces whose last activity is older than the
 *    settle delay, past a per-project cursor, and queues one job per enabled
 *    check that samples and applies to the run.
 * 2. Run: claim due jobs with SKIP LOCKED, evaluate, and upsert one score per
 *    check per run. Judge calls are rate limited per project and back off
 *    exponentially on provider errors. Jobs live in Postgres, so a restart
 *    resumes where it stopped; jobs left running by a dead process are
 *    released after a lease timeout.
 */

export const QUALITY_CHECKS_FEATURE = "quality-checks";

export type SkipReason = "needs_capture" | "needs_key" | "no_text" | "not_applicable" | "check_disabled" | "run_missing";

export interface QualityWorkerOptions {
  /** Wait this long after a run's last activity before evaluating it. */
  settleMs?: number;
  /** How far back the first scan of a project reaches. */
  lookbackMs?: number;
  scanLimit?: number;
  batchSize?: number;
  concurrency?: number;
  judgeRequestsPerMinute?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  leaseMs?: number;
  judgeTimeoutMs?: number;
  endpoints?: JudgeEndpoints;
  fetchImpl?: typeof fetch;
  rateLimiter?: ProjectRateLimiter;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function workerDefaults(options: QualityWorkerOptions = {}): Required<Omit<QualityWorkerOptions, "endpoints" | "fetchImpl" | "rateLimiter">> & Pick<QualityWorkerOptions, "endpoints" | "fetchImpl" | "rateLimiter"> {
  return {
    settleMs: options.settleMs ?? envNumber("COSTKEY_QUALITY_SETTLE_SECONDS", 120) * 1000,
    lookbackMs: options.lookbackMs ?? 6 * 60 * 60 * 1000,
    scanLimit: options.scanLimit ?? 500,
    batchSize: options.batchSize ?? 20,
    concurrency: options.concurrency ?? 4,
    judgeRequestsPerMinute: options.judgeRequestsPerMinute ?? envNumber("COSTKEY_QUALITY_JUDGE_RPM", 30),
    maxAttempts: options.maxAttempts ?? 5,
    backoffBaseMs: options.backoffBaseMs ?? 30_000,
    backoffMaxMs: options.backoffMaxMs ?? 60 * 60 * 1000,
    leaseMs: options.leaseMs ?? 10 * 60 * 1000,
    judgeTimeoutMs: options.judgeTimeoutMs ?? 60_000,
    endpoints: options.endpoints,
    fetchImpl: options.fetchImpl,
    rateLimiter: options.rateLimiter,
  };
}

/** Exponential backoff: base, 2x base, 4x base and so on, capped. */
export function backoffDelay(attempts: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

/** Judge calls per project per minute, as a sliding window. */
export class ProjectRateLimiter {
  private readonly calls = new Map<string, number[]>();
  constructor(private readonly perMinute: number) {}

  /** Take a slot: 0 when allowed now, otherwise milliseconds until one frees up. */
  take(projectId: string, now = Date.now()): number {
    if (this.perMinute <= 0) return 0;
    const windowStart = now - 60_000;
    const recent = (this.calls.get(projectId) ?? []).filter((at) => at > windowStart);
    if (recent.length >= this.perMinute) {
      this.calls.set(projectId, recent);
      return Math.max(1, recent[0] + 60_000 - now);
    }
    recent.push(now);
    this.calls.set(projectId, recent);
    return 0;
  }
}

const sharedLimiters = new Map<number, ProjectRateLimiter>();
function limiterFor(options: ReturnType<typeof workerDefaults>): ProjectRateLimiter {
  if (options.rateLimiter) return options.rateLimiter;
  let limiter = sharedLimiters.get(options.judgeRequestsPerMinute);
  if (!limiter) {
    limiter = new ProjectRateLimiter(options.judgeRequestsPerMinute);
    sharedLimiters.set(options.judgeRequestsPerMinute, limiter);
  }
  return limiter;
}

export interface ProjectCapture {
  /** Text capture is on: prompts and responses are stored. */
  textCapture: boolean;
  redaction: boolean;
}

export async function projectCapture(pool: pg.Pool | pg.PoolClient, projectId: string): Promise<ProjectCapture> {
  try {
    const result = await pool.query(
      "SELECT capture_mode, body_capture_enabled, redaction_enabled FROM project_settings WHERE project_id = $1",
      [projectId],
    );
    const row = result.rows[0] as { capture_mode?: string; body_capture_enabled?: boolean; redaction_enabled?: boolean } | undefined;
    // No settings row is treated as metadata-only, as at ingest.
    return { textCapture: row?.capture_mode === "text" && row.body_capture_enabled !== false, redaction: row?.redaction_enabled !== false };
  } catch {
    return { textCapture: false, redaction: true };
  }
}

/** Is this check due to run on this run at all? Sampling, then applies-to. */
export function checkWantsRun(check: Pick<QualityCheck, "sampleRate" | "appliesTo" | "appliesToNames">, facts: Pick<RunFacts, "traceId" | "names">): "yes" | "not_sampled" | "not_applicable" {
  if (!isSampled(facts.traceId, check.sampleRate)) return "not_sampled";
  if (!checkAppliesToRun(check.appliesTo, check.appliesToNames, facts)) return "not_applicable";
  return "yes";
}

// ── Scan ──────────────────────────────────────────────────────────────────

export async function enqueueFinishedRuns(pool: pg.Pool, options: QualityWorkerOptions = {}): Promise<number> {
  const config = workerDefaults(options);
  const projects = await pool.query("SELECT DISTINCT project_id FROM quality_checks WHERE enabled ORDER BY project_id");
  let queued = 0;
  for (const row of projects.rows as Array<{ project_id: string }>) {
    try {
      queued += await enqueueProject(pool, row.project_id, config);
    } catch (error) {
      console.error("[costkey] Quality check scan error:", error);
    }
  }
  return queued;
}

async function enqueueProject(pool: pg.Pool, projectId: string, config: ReturnType<typeof workerDefaults>): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`costkey:quality-scan:${projectId}`]);
    if (!locked.rows[0]?.ok) { await client.query("ROLLBACK"); return 0; }
    const checks = (await listChecks(client, projectId)).filter((check) => check.enabled && check.sampleRate > 0);
    if (checks.length === 0) { await client.query("ROLLBACK"); return 0; }
    const cursorRow = await client.query("SELECT scanned_at, scanned_trace_id FROM quality_check_cursors WHERE project_id = $1", [projectId]);
    const earliestCheck = checks.reduce((min, check) => (check.createdAt < min ? check.createdAt : min), checks[0].createdAt);
    const cursorAt = cursorRow.rows[0]?.scanned_at
      ? new Date(cursorRow.rows[0].scanned_at as Date).toISOString()
      : new Date(Math.max(Date.parse(earliestCheck), Date.now() - config.lookbackMs)).toISOString();
    const cursorId = String(cursorRow.rows[0]?.scanned_trace_id ?? "");
    const candidates = await client.query(
      `SELECT t.id, t.updated_at
       FROM traces t
       WHERE t.project_id = $1
         AND (t.updated_at, t.id) > ($2::timestamptz, $3::text)
         AND t.updated_at <= NOW() - ($4::double precision * INTERVAL '1 millisecond')
       ORDER BY t.updated_at, t.id
       LIMIT $5`,
      [projectId, cursorAt, cursorId, config.settleMs, config.scanLimit],
    );
    let queued = 0;
    let last: { at: string; id: string } | null = null;
    for (const trace of candidates.rows as Array<{ id: string; updated_at: Date }>) {
      const updatedAt = new Date(trace.updated_at).toISOString();
      last = { at: updatedAt, id: trace.id };
      const facts = await loadRunFacts(client, projectId, trace.id);
      // A run with an open span is still going; its next span event bumps the
      // trace past the cursor again, and it is scanned then.
      if (!facts || facts.calls + facts.spans === 0 || facts.runningSpans > 0) continue;
      for (const check of checks) {
        if (updatedAt < check.createdAt) continue;
        if (checkWantsRun(check, facts) !== "yes") continue;
        const inserted = await client.query(
          `INSERT INTO quality_check_jobs (project_id, check_id, trace_id, origin)
           VALUES ($1, $2, $3, 'auto') ON CONFLICT (check_id, trace_id) DO NOTHING`,
          [projectId, check.id, trace.id],
        );
        queued += inserted.rowCount ?? 0;
      }
    }
    if (last) {
      await client.query(
        `INSERT INTO quality_check_cursors (project_id, scanned_at, scanned_trace_id, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (project_id) DO UPDATE SET scanned_at = EXCLUDED.scanned_at,
           scanned_trace_id = EXCLUDED.scanned_trace_id, updated_at = NOW()`,
        [projectId, last.at, last.id],
      );
    }
    await client.query("COMMIT");
    return queued;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ── Backfill ──────────────────────────────────────────────────────────────

export const MAX_BACKFILL_RUNS = 200;

export class BackfillBusyError extends Error {}

/**
 * Queue a check on the most recent finished runs it samples and applies to,
 * at most 200. Runs it already scored are evaluated again.
 */
export async function backfillCheck(pool: pg.Pool, check: QualityCheck, limit = MAX_BACKFILL_RUNS, options: QualityWorkerOptions = {}): Promise<{ queued: number }> {
  const config = workerDefaults(options);
  const cap = Math.max(1, Math.min(MAX_BACKFILL_RUNS, Math.floor(limit)));
  const busy = await pool.query(
    "SELECT 1 FROM quality_check_jobs WHERE check_id = $1 AND origin = 'backfill' AND status IN ('pending', 'running') LIMIT 1",
    [check.id],
  );
  if ((busy.rowCount ?? 0) > 0) throw new BackfillBusyError("This check is already running on recent runs");
  const runs = await pool.query(
    `WITH runs AS (
       SELECT e.trace_id, MAX(e.timestamp + COALESCE(e.duration_ms, 0) * INTERVAL '1 millisecond') AS last_at
       FROM events e
       WHERE e.project_id = $1 AND e.trace_id IS NOT NULL AND COALESCE(e.event_type, 'call') = 'call'
         AND e.timestamp >= NOW() - INTERVAL '30 days'
       GROUP BY e.trace_id
     )
     SELECT r.trace_id FROM runs r
     WHERE r.last_at <= NOW() - ($2::double precision * INTERVAL '1 millisecond')
       AND ${sampleBucketSql("r.trace_id")} < $3::double precision
       AND ($4::text <> 'named'
         OR EXISTS (SELECT 1 FROM spans s WHERE s.project_id = $1 AND s.trace_id = r.trace_id
                     AND s.kind IN ('agent', 'workflow') AND s.name = ANY($5::text[]))
         OR EXISTS (SELECT 1 FROM events n WHERE n.project_id = $1 AND n.trace_id = r.trace_id
                     AND (n.group_name = ANY($5::text[]) OR n.trace_name = ANY($5::text[]) OR n.context->>'agent' = ANY($5::text[])))
         OR EXISTS (SELECT 1 FROM traces t WHERE t.project_id = $1 AND t.id = r.trace_id AND t.trace_name = ANY($5::text[])))
       AND NOT EXISTS (SELECT 1 FROM spans o WHERE o.project_id = $1 AND o.trace_id = r.trace_id AND o.status = 'running')
     ORDER BY r.last_at DESC, r.trace_id
     LIMIT $6`,
    [check.projectId, config.settleMs, check.sampleRate, check.appliesTo, check.appliesToNames, cap],
  );
  const traceIds = (runs.rows as Array<{ trace_id: string }>).map((row) => row.trace_id);
  if (traceIds.length === 0) return { queued: 0 };
  const result = await pool.query(
    `INSERT INTO quality_check_jobs (project_id, check_id, trace_id, origin, status, attempts, next_run_at)
     SELECT $1, $2, trace_id, 'backfill', 'pending', 0, NOW() FROM unnest($3::text[]) AS trace_id
     ON CONFLICT (check_id, trace_id) DO UPDATE SET
       origin = 'backfill', status = 'pending', attempts = 0, next_run_at = NOW(),
       skip_reason = NULL, last_error = NULL, locked_at = NULL, updated_at = NOW()
     WHERE quality_check_jobs.status <> 'running'`,
    [check.projectId, check.id, traceIds],
  );
  return { queued: result.rowCount ?? 0 };
}

// ── Run ───────────────────────────────────────────────────────────────────

export interface QualityJob {
  id: string;
  projectId: string;
  checkId: string;
  traceId: string;
  attempts: number;
}

/** Release jobs a dead process left running so another tick picks them up. */
export async function releaseStaleJobs(pool: pg.Pool, leaseMs: number): Promise<number> {
  const result = await pool.query(
    `UPDATE quality_check_jobs SET status = 'pending', locked_at = NULL, updated_at = NOW()
     WHERE status = 'running' AND locked_at < NOW() - ($1::double precision * INTERVAL '1 millisecond')`,
    [leaseMs],
  );
  return result.rowCount ?? 0;
}

export async function claimDueJobs(pool: pg.Pool, limit: number): Promise<QualityJob[]> {
  const result = await pool.query(
    `UPDATE quality_check_jobs j
     SET status = 'running', attempts = j.attempts + 1, locked_at = NOW(), updated_at = NOW()
     WHERE j.id IN (
       SELECT id FROM quality_check_jobs
       WHERE status = 'pending' AND next_run_at <= NOW()
       ORDER BY next_run_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING j.id, j.project_id, j.check_id, j.trace_id, j.attempts`,
    [limit],
  );
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    checkId: String(row.check_id),
    traceId: String(row.trace_id),
    attempts: Number(row.attempts),
  }));
}

async function finishJob(pool: pg.Pool, job: QualityJob, status: "done" | "skipped" | "failed", fields: { scoreId?: string; skipReason?: SkipReason; error?: string | null }): Promise<void> {
  await pool.query(
    `UPDATE quality_check_jobs
     SET status = $2, score_id = COALESCE($3, score_id), skip_reason = $4, last_error = $5,
         locked_at = NULL, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [job.id, status, fields.scoreId ?? null, fields.skipReason ?? null, fields.error ?? null],
  );
}

async function rescheduleJob(pool: pg.Pool, job: QualityJob, delayMs: number, options: { error?: string | null; refundAttempt?: boolean }): Promise<void> {
  await pool.query(
    `UPDATE quality_check_jobs
     SET status = 'pending', locked_at = NULL, updated_at = NOW(),
         next_run_at = NOW() + ($2::double precision * INTERVAL '1 millisecond'),
         attempts = CASE WHEN $3 THEN GREATEST(attempts - 1, 0) ELSE attempts END,
         last_error = COALESCE($4, last_error)
     WHERE id = $1`,
    [job.id, delayMs, options.refundAttempt === true, options.error ?? null],
  );
}

/** Upsert the check's score for the run. The reason follows comment privacy. */
export async function upsertCheckScore(
  pool: pg.Pool,
  check: QualityCheck,
  facts: Pick<RunFacts, "traceId" | "endedAt">,
  verdict: { value: number; label: string; reason: string | null },
  capture: ProjectCapture,
): Promise<string> {
  const id = scoreIdFor(check.id, facts.traceId);
  let comment: string | undefined;
  if (verdict.reason) {
    if (check.kind === "rule") {
      // Rule reasons are built from counts and span names, never captured text.
      comment = verdict.reason;
    } else if (capture.textCapture) {
      comment = capture.redaction ? String(redactCapturedContent(verdict.reason)) : verdict.reason;
    }
  }
  await recordAccountingEvent(pool, check.projectId, {
    id,
    eventType: "score",
    timestamp: facts.endedAt ?? new Date().toISOString(),
    traceId: facts.traceId,
    name: check.name,
    value: verdict.value,
    label: verdict.label.slice(0, 60),
    ...(comment ? { comment } : {}),
    source: check.kind === "judge" ? "judge" : "code",
  });
  return id;
}

/** Record the judge's own provider usage as a priced CostKey call in the project. */
export async function recordJudgeUsage(pool: pg.Pool, check: QualityCheck, job: QualityJob, call: JudgeCall, startedAt: Date): Promise<void> {
  if (!call.usage) return;
  const input = call.usage.inputTokens ?? 0;
  const output = call.usage.outputTokens ?? 0;
  const id = `qcj_${createHash("sha256").update(`${job.id}:${job.attempts}:${check.id}:${job.traceId}`).digest("hex").slice(0, 32)}`;
  const result = await recordInternalEvents(pool, check.projectId, [{
    id,
    eventType: "call",
    timestamp: startedAt.toISOString(),
    provider: call.provider,
    model: call.model,
    url: call.url,
    method: "POST",
    statusCode: call.statusCode,
    durationMs: call.durationMs,
    streaming: false,
    usage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
    context: { feature: QUALITY_CHECKS_FEATURE, operation: check.name },
  }]);
  if (result.status >= 300) console.warn("[costkey] Could not record judge usage:", result.body["error"] ?? result.status);
}

export type JobOutcome = "done" | "skipped" | "failed" | "retry" | "deferred";

export async function processJob(pool: pg.Pool, job: QualityJob, options: QualityWorkerOptions = {}): Promise<JobOutcome> {
  const config = workerDefaults(options);
  const check = await getCheck(pool, job.projectId, job.checkId);
  if (!check || !check.enabled) {
    await finishJob(pool, job, "skipped", { skipReason: "check_disabled" });
    return "skipped";
  }
  const facts = await loadRunFacts(pool, job.projectId, job.traceId);
  if (!facts) {
    await finishJob(pool, job, "skipped", { skipReason: "run_missing" });
    return "skipped";
  }
  const capture = await projectCapture(pool, job.projectId);

  if (check.kind === "rule") {
    const outcome = evaluateRule(check.rule ?? "run_succeeded", facts, check.target);
    if (outcome.kind === "skip") {
      await finishJob(pool, job, "skipped", { skipReason: outcome.reason, error: outcome.detail });
      return "skipped";
    }
    const scoreId = await upsertCheckScore(pool, check, facts, outcome, capture);
    await finishJob(pool, job, "done", { scoreId });
    return "done";
  }

  // Rubric checks read captured text. Metadata-only projects never send any.
  if (!capture.textCapture) {
    await finishJob(pool, job, "skipped", { skipReason: "needs_capture" });
    return "skipped";
  }
  if (!check.judgeKeyEncrypted || !check.judgeProvider || !check.judgeModel) {
    await finishJob(pool, job, "skipped", { skipReason: "needs_key" });
    return "skipped";
  }
  const apiKey = openJudgeKey(check);
  if (!apiKey) {
    await finishJob(pool, job, "failed", { error: "The saved API key can't be read. Enter it again." });
    return "failed";
  }
  const transcript = await loadRunTranscript(pool, job.projectId, job.traceId);
  if (!transcript || (!transcript.answer && !transcript.question)) {
    await finishJob(pool, job, "skipped", { skipReason: "no_text", error: "No prompt or response text was captured for this run." });
    return "skipped";
  }
  const wait = limiterFor(config).take(job.projectId);
  if (wait > 0) {
    await rescheduleJob(pool, job, wait, { refundAttempt: true });
    return "deferred";
  }

  const startedAt = new Date();
  let call: JudgeCall;
  try {
    call = await callJudge({
      provider: check.judgeProvider,
      model: check.judgeModel,
      apiKey,
      rubric: check.rubric ?? "",
      transcript: formatTranscript(transcript),
      endpoints: config.endpoints,
      fetchImpl: config.fetchImpl,
      timeoutMs: config.judgeTimeoutMs,
    });
  } catch (error) {
    const providerError = error instanceof JudgeProviderError ? error : null;
    if (providerError?.call) await recordJudgeUsage(pool, check, job, providerError.call, startedAt).catch((usageError) => console.error("[costkey] Judge usage error:", usageError));
    const message = error instanceof Error ? error.message : "The judge call failed";
    const retryable = providerError ? providerError.retryable : true;
    if (!retryable || job.attempts >= config.maxAttempts) {
      await finishJob(pool, job, "failed", { error: message });
      return "failed";
    }
    const delay = Math.max(backoffDelay(job.attempts, config.backoffBaseMs, config.backoffMaxMs), providerError?.retryAfterMs ?? 0);
    await rescheduleJob(pool, job, delay, { error: message });
    if (providerError?.status === 429) {
      // The key is rate limited: hold this check's other queued judge jobs too.
      await pool.query(
        `UPDATE quality_check_jobs SET next_run_at = GREATEST(next_run_at, NOW() + ($2::double precision * INTERVAL '1 millisecond'))
         WHERE check_id = $1 AND status = 'pending' AND id <> $3`,
        [check.id, delay, job.id],
      );
    }
    return "retry";
  }

  await recordJudgeUsage(pool, check, job, call, startedAt).catch((error) => console.error("[costkey] Judge usage error:", error));
  if (!call.result) {
    const message = call.parseError ?? "The judge reply could not be read";
    if (job.attempts >= config.maxAttempts) {
      await finishJob(pool, job, "failed", { error: message });
      return "failed";
    }
    await rescheduleJob(pool, job, backoffDelay(job.attempts, config.backoffBaseMs, config.backoffMaxMs), { error: message });
    return "retry";
  }
  const scoreId = await upsertCheckScore(pool, check, facts, { value: call.result.score, label: call.result.label, reason: call.result.reason }, capture);
  await finishJob(pool, job, "done", { scoreId });
  return "done";
}

/** Claim and run up to one batch of due jobs. */
export async function processDueJobs(pool: pg.Pool, options: QualityWorkerOptions = {}): Promise<Record<JobOutcome, number>> {
  const config = workerDefaults(options);
  const counts: Record<JobOutcome, number> = { done: 0, skipped: 0, failed: 0, retry: 0, deferred: 0 };
  await releaseStaleJobs(pool, config.leaseMs);
  const jobs = await claimDueJobs(pool, config.batchSize);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(config.concurrency, jobs.length)) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        counts[await processJob(pool, job, config)] += 1;
      } catch (error) {
        console.error("[costkey] Quality check job error:", error);
        const message = error instanceof Error ? error.message : "Evaluation failed";
        if (job.attempts >= config.maxAttempts) await finishJob(pool, job, "failed", { error: message }).catch(() => undefined);
        else await rescheduleJob(pool, job, backoffDelay(job.attempts, config.backoffBaseMs, config.backoffMaxMs), { error: message }).catch(() => undefined);
        counts.retry += 1;
      }
    }
  });
  await Promise.all(lanes);
  return counts;
}

/**
 * One worker tick: scan for finished runs, then run due jobs. Keeps claiming
 * full batches for up to `tickBudgetMs` so a backfill drains in minutes.
 */
export async function runQualityChecks(pool: pg.Pool, options: QualityWorkerOptions & { tickBudgetMs?: number } = {}): Promise<{ queued: number; outcomes: Record<JobOutcome, number> }> {
  const config = workerDefaults(options);
  const started = Date.now();
  const queued = await enqueueFinishedRuns(pool, options);
  const outcomes: Record<JobOutcome, number> = { done: 0, skipped: 0, failed: 0, retry: 0, deferred: 0 };
  for (;;) {
    const batch = await processDueJobs(pool, options);
    let handled = 0;
    for (const key of Object.keys(outcomes) as JobOutcome[]) { outcomes[key] += batch[key]; handled += batch[key]; }
    // A deferred job is waiting on the rate limit; stop rather than spin on it.
    if (handled < config.batchSize || batch.deferred > 0 || Date.now() - started > (options.tickBudgetMs ?? 10_000)) break;
  }
  return { queued, outcomes };
}

/** Start the background worker. Ticks never overlap within a process. */
export function startQualityCheckWorker(pool: pg.Pool, options: QualityWorkerOptions & { intervalMs?: number } = {}): NodeJS.Timeout {
  let running = false;
  const intervalMs = options.intervalMs ?? envNumber("COSTKEY_QUALITY_WORKER_INTERVAL_SECONDS", 15) * 1000;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    void runQualityChecks(pool, options)
      .catch((error) => console.error("[costkey] Quality check worker error:", error))
      .finally(() => { running = false; });
  }, Math.max(1_000, intervalMs));
  handle.unref();
  return handle;
}
