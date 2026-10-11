import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { ensureQualityCheckSchema, initDatabase, shutdownDatabase } from "../db.js";
import { createIngestRouter } from "../ingest.js";
import { createQualityRouter } from "../quality-api.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { decryptSecret } from "../notifications.js";
import { sampleBucket } from "../quality-checks/sampling.js";
import { sampleBucketSql } from "../quality-checks/sampling.js";
import { getCheck, scoreIdFor } from "../quality-checks/store.js";
import { loadRunFacts } from "../quality-checks/rules.js";
import {
  backfillCheck,
  claimDueJobs,
  enqueueFinishedRuns,
  processDueJobs,
  processJob,
  projectCapture,
  ProjectRateLimiter,
  upsertCheckScore,
  type QualityWorkerOptions,
} from "../quality-checks/worker.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("the Postgres sampling twin buckets runs exactly like the worker", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  try {
    const ids = Array.from({ length: 300 }, (_, index) => `tr_${index}_${randomBytes(3).toString("hex")}`);
    const result = await pool.query(`SELECT id, ${sampleBucketSql("id")} AS bucket FROM unnest($1::text[]) AS id`, [ids]);
    for (const row of result.rows as Array<{ id: string; bucket: number }>) {
      assert.ok(Math.abs(Number(row.bucket) - sampleBucket(row.id)) < 1e-9, row.id);
    }
  } finally {
    await pool.end();
  }
});

interface MockProvider {
  url: string;
  requests: Array<{ key: string; body: Record<string, any> }>;
  close: () => Promise<void>;
}

/** An OpenAI-compatible judge endpoint. Behaviour depends on the bearer key. */
async function startMockProvider(): Promise<MockProvider> {
  const requests: MockProvider["requests"] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      requests.push({ key, body: JSON.parse(raw) });
      res.setHeader("content-type", "application/json");
      if (key.includes("flaky")) { res.statusCode = 429; res.setHeader("retry-after", "0"); res.end(JSON.stringify({ error: { message: "rate limited" } })); return; }
      if (key.includes("bad")) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: "invalid key" } })); return; }
      res.end(JSON.stringify({
        model: "gpt-4o-mini",
        choices: [{ message: { role: "assistant", content: JSON.stringify({ score: 0.8, label: "pass", reason: "Answered the order question. Leaked sk-abcdefghijklmnopqrstuvwxyz123456 in passing." }) } }],
        usage: { prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("quality checks: API permissions, worker, judges, gating, retries and idempotent scores", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_qc_${suffix}`;
  const textProject = `project_qc_text_${suffix}`;
  const metaProject = `project_qc_meta_${suffix}`;
  const textKey = `key_qc_text_${suffix}`;
  const metaKey = `key_qc_meta_${suffix}`;
  const users = { owner: `owner-${suffix}`, admin: `admin-${suffix}`, developer: `dev-${suffix}`, viewer: `viewer-${suffix}` };
  const provider = await startMockProvider();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    const role = String(req.headers["x-test-role"] ?? "owner") as keyof typeof users;
    (req as any).user = { id: users[role], orgId, role };
    next();
  });
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await ensureQualityCheckSchema(pool);
    await ensureQualityCheckSchema(pool); // idempotent
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [orgId, "QC", `qc-${suffix}`]);
    for (const [role, id] of Object.entries(users)) {
      await pool.query("INSERT INTO users(id,email,password_hash,name,org_id,role) VALUES ($1,$2,'x',$3,$4,$5)", [id, `${id}@example.com`, role, orgId, role]);
    }
    for (const [projectId, key, mode] of [[textProject, textKey, "text"], [metaProject, metaKey, "metadata"]] as const) {
      await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,$1,$2,$3)", [projectId, orgId, key]);
      await pool.query(
        `INSERT INTO project_settings(project_id, capture_mode, body_capture_enabled, redaction_enabled)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (project_id) DO UPDATE SET capture_mode = EXCLUDED.capture_mode, body_capture_enabled = EXCLUDED.body_capture_enabled, redaction_enabled = TRUE`,
        [projectId, mode, mode === "text"],
      );
      for (const member of [users.developer, users.viewer]) {
        await pool.query("INSERT INTO project_memberships(project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [projectId, member]);
      }
    }
    app.use(createIngestRouter(pool));
    app.use(createQualityRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const api = async (method: string, path: string, body?: unknown, role = "owner") => {
        const response = await fetch(`${baseUrl}/api/v1/projects/${path}`, {
          method,
          headers: { "content-type": "application/json", "x-test-role": role },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        return { status: response.status, text, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
      };

      // ── Permissions: only owners and admins manage checks ──
      const ruleBody = { kind: "rule", rule: "run_succeeded" };
      for (const role of ["viewer", "developer"]) {
        assert.equal((await api("POST", `${textProject}/quality/checks`, ruleBody, role)).status, 403, role);
      }
      const runSucceeded = await api("POST", `${textProject}/quality/checks`, ruleBody, "owner");
      assert.equal(runSucceeded.status, 201);
      const runSucceededId = runSucceeded.json.check.id as string;
      const created = {
        toolErrors: (await api("POST", `${textProject}/quality/checks`, { kind: "rule", rule: "tool_errors" }, "admin")).json.check.id as string,
        retries: (await api("POST", `${textProject}/quality/checks`, { kind: "rule", rule: "retries" })).json.check.id as string,
        latency: (await api("POST", `${textProject}/quality/checks`, { kind: "rule", rule: "latency", target: 30 })).json.check.id as string,
        unsampled: (await api("POST", `${textProject}/quality/checks`, { kind: "rule", rule: "cost", sampleRate: 0 })).json.check.id as string,
      };
      for (const role of ["viewer", "developer"]) {
        assert.equal((await api("PATCH", `${textProject}/quality/checks/${created.latency}`, { enabled: false }, role)).status, 403);
        assert.equal((await api("POST", `${textProject}/quality/checks/${created.latency}/backfill`, {}, role)).status, 403);
        assert.equal((await api("DELETE", `${textProject}/quality/checks/${created.latency}`, undefined, role)).status, 403);
      }
      const duplicate = await api("POST", `${textProject}/quality/checks`, ruleBody);
      assert.equal(duplicate.status, 400, "names are unique per project");

      const judgeKey = "sk-good-judge-key-0001";
      const judge = await api("POST", `${textProject}/quality/checks`, {
        kind: "judge", template: "answered", judgeProvider: "openai", apiKey: judgeKey, appliesTo: "named", appliesToNames: ["support-agent"],
      });
      assert.equal(judge.status, 201);
      assert.ok(!judge.text.includes(judgeKey), "the key is write-only");
      assert.equal(judge.json.check.hasKey, true);
      assert.equal(judge.json.check.keyHint, "0001");
      const judgeId = judge.json.check.id as string;
      const stored = await pool.query("SELECT judge_key_encrypted FROM quality_checks WHERE id = $1", [judgeId]);
      assert.notEqual(stored.rows[0].judge_key_encrypted, judgeKey);
      assert.equal(decryptSecret(stored.rows[0].judge_key_encrypted), judgeKey, "the stored key decrypts to the original");
      const flakyId = (await api("POST", `${textProject}/quality/checks`, {
        kind: "judge", template: "faithfulness", name: "Flaky judge", apiKey: "sk-flaky-judge-key-02", appliesTo: "named", appliesToNames: ["support-agent"],
      })).json.check.id as string;
      const badId = (await api("POST", `${textProject}/quality/checks`, {
        kind: "judge", template: "safety", name: "Bad key judge", apiKey: "sk-bad-judge-key-0003", appliesTo: "named", appliesToNames: ["support-agent"],
      })).json.check.id as string;
      const metaJudgeId = (await api("POST", `${metaProject}/quality/checks`, {
        kind: "judge", template: "answered", apiKey: "sk-good-judge-key-meta",
      })).json.check.id as string;

      // ── Two finished runs per project, sent through ingest ──
      const now = Date.now();
      const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
      const runEvents = (tag: string) => {
        const call = (id: string, trace: string, span: string, extra: Record<string, unknown> = {}) => ({
          id, timestamp: iso(-60_000), durationMs: 1_000, provider: "openai", model: "gpt-4o", statusCode: 200,
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, traceId: trace, spanId: span, ...extra,
        });
        const a = `trA_${tag}`;
        const b = `trB_${tag}`;
        return [
          { id: `agA_${tag}`, eventType: "span", kind: "agent", name: "support-agent", traceId: a, startedAt: iso(-90_000), endedAt: iso(-30_000), status: "ok", timestamp: iso(-90_000) },
          { id: `toolA_${tag}`, eventType: "span", kind: "tool", name: "lookup_order", traceId: a, parentSpanId: `agA_${tag}`, startedAt: iso(-70_000), endedAt: iso(-69_000), status: "ok", timestamp: iso(-70_000) },
          call(`cA1_${tag}`, a, `agA_${tag}`, {
            requestBody: { messages: [{ role: "system", content: "Answer briefly." }, { role: "user", content: "Where is order 42?" }] },
            responseBody: { choices: [{ message: { content: "Let me check." } }] },
          }),
          call(`cA2_${tag}`, a, `agA_${tag}`, {
            timestamp: iso(-50_000),
            requestBody: { messages: [{ role: "user", content: "Where is order 42?" }, { role: "tool", content: "Order 42 shipped Tuesday" }] },
            responseBody: { choices: [{ message: { content: "Order 42 shipped on Tuesday." } }] },
          }),
          { id: `agB_${tag}`, eventType: "span", kind: "agent", name: "research-agent", traceId: b, startedAt: iso(-90_000), endedAt: iso(-80_000), status: "error", timestamp: iso(-90_000) },
          { id: `toolB_${tag}`, eventType: "span", kind: "tool", name: "web_search", traceId: b, parentSpanId: `agB_${tag}`, startedAt: iso(-88_000), endedAt: iso(-87_000), status: "error", timestamp: iso(-88_000) },
          call(`cB1_${tag}`, b, `toolB_${tag}`, { timestamp: iso(-86_000), statusCode: 429 }),
          call(`cB2_${tag}`, b, `toolB_${tag}`, { timestamp: iso(-85_000), parentEventId: `cB1_${tag}` }),
        ];
      };
      for (const [key, tag] of [[textKey, `t_${suffix}`], [metaKey, `m_${suffix}`]]) {
        const response = await fetch(`${baseUrl}/api/v1/events`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ sdkVersion: "0.6.0", events: runEvents(tag) }),
        });
        assert.equal(response.status, 202);
      }
      const traceA = `trA_t_${suffix}`;
      const traceB = `trB_t_${suffix}`;

      // ── Scan: settle delay first, then one job per sampled, applicable check ──
      const options: QualityWorkerOptions = {
        settleMs: 0,
        endpoints: { openai: provider.url },
        rateLimiter: new ProjectRateLimiter(100),
        backoffBaseMs: 60_000,
        maxAttempts: 3,
      };
      assert.equal(await enqueueFinishedRuns(pool, { ...options, settleMs: 10 * 60_000 }), 0, "runs inside the settle delay wait");
      const queued = await enqueueFinishedRuns(pool, options);
      // Text project: 4 rules x 2 runs + 3 judges on run A. Meta project: 1 judge x 2 runs.
      assert.equal(queued, 13);
      assert.equal(await enqueueFinishedRuns(pool, options), 0, "the cursor does not queue the same runs twice");
      const unsampledJobs = await pool.query("SELECT COUNT(*)::int AS n FROM quality_check_jobs WHERE check_id = $1", [created.unsampled]);
      assert.equal(unsampledJobs.rows[0].n, 0, "a 0% sample never runs");

      const outcomes = await processDueJobs(pool, { ...options, batchSize: 50 });
      assert.deepEqual(outcomes, { done: 9, skipped: 2, failed: 1, retry: 1, deferred: 0 });

      // ── Rule results ──
      const score = async (checkId: string, traceId: string) => (await pool.query(
        "SELECT value, label, comment, source, name FROM scores WHERE project_id = $1 AND id = $2",
        [textProject, scoreIdFor(checkId, traceId)],
      )).rows[0] as Record<string, any> | undefined;
      assert.deepEqual([(await score(runSucceededId, traceA))?.value, (await score(runSucceededId, traceA))?.label], [1, "pass"]);
      const failedRun = await score(runSucceededId, traceB);
      assert.deepEqual([failedRun?.value, failedRun?.label, failedRun?.source], [0, "fail", "code"]);
      assert.match(String(failedRun?.comment), /2 failed spans \(research-agent, web_search\)|2 failed spans \(web_search, research-agent\)/);
      assert.equal((await score(created.toolErrors, traceB))?.value, 0);
      assert.equal((await score(created.toolErrors, traceA))?.value, 1);
      assert.deepEqual([(await score(created.retries, traceB))?.value, (await score(created.retries, traceB))?.label], [0.5, "fail"]);
      assert.deepEqual([(await score(created.latency, traceA))?.value, (await score(created.latency, traceA))?.label], [0.5, "fail"], "run A took 60s against 30s");
      assert.equal((await score(created.latency, traceB))?.label, "pass");

      // ── Judge against the mocked provider ──
      const verdict = await score(judgeId, traceA);
      assert.deepEqual([verdict?.value, verdict?.label, verdict?.source, verdict?.name], [0.8, "pass", "judge", "Answered the question"]);
      assert.match(String(verdict?.comment), /^Answered the order question\./);
      assert.ok(!String(verdict?.comment).includes("sk-abcdefghijklmnop"), "the reason is redacted like any captured comment");
      const goodRequest = provider.requests.find((request) => request.key === judgeKey);
      assert.ok(goodRequest, "the worker decrypted and sent the stored key");
      const prompt = String(goodRequest!.body.messages[1].content);
      assert.match(prompt, /Where is order 42\?/);
      assert.match(prompt, /Order 42 shipped Tuesday/);
      assert.match(prompt, /Order 42 shipped on Tuesday\./);
      assert.equal(await score(judgeId, traceB), undefined, "applies-to keeps the judge off research-agent");
      const judgeUsage = await pool.query(
        `SELECT provider, model, input_tokens, output_tokens, cost_usd, trace_id, context
         FROM events WHERE project_id = $1 AND context->>'feature' = 'quality-checks'`,
        [textProject],
      );
      assert.equal(judgeUsage.rowCount, 1, "one priced judge call, none for the failed attempts");
      const usage = judgeUsage.rows[0] as Record<string, any>;
      assert.deepEqual([usage.provider, usage.model, usage.input_tokens, usage.output_tokens, usage.trace_id], ["openai", "gpt-4o-mini", 1_000, 50, null]);
      assert.ok(Number(usage.cost_usd) > 0, "evaluation spend is priced");
      assert.equal(usage.context.operation, "Answered the question");

      // ── Backoff on a 429, immediate failure on a 401 ──
      const job = async (checkId: string, traceId = traceA) => (await pool.query(
        "SELECT id, status, attempts, last_error, skip_reason, EXTRACT(EPOCH FROM (next_run_at - NOW())) AS wait FROM quality_check_jobs WHERE check_id = $1 AND trace_id = $2",
        [checkId, traceId],
      )).rows[0] as Record<string, any>;
      const flaky = await job(flakyId);
      assert.deepEqual([flaky.status, flaky.attempts], ["pending", 1]);
      assert.ok(Number(flaky.wait) > 50 && Number(flaky.wait) <= 60, `first backoff ~60s, got ${flaky.wait}`);
      assert.match(String(flaky.last_error), /429/);
      const bad = await job(badId);
      assert.deepEqual([bad.status, bad.attempts], ["failed", 1]);
      assert.match(String(bad.last_error), /rejected the API key/);
      await pool.query("UPDATE quality_check_jobs SET next_run_at = NOW() WHERE check_id = $1", [flakyId]);
      await processDueJobs(pool, options);
      const flakyTwice = await job(flakyId);
      assert.deepEqual([flakyTwice.status, flakyTwice.attempts], ["pending", 2]);
      assert.ok(Number(flakyTwice.wait) > 110 && Number(flakyTwice.wait) <= 120, `second backoff ~120s, got ${flakyTwice.wait}`);
      await pool.query("UPDATE quality_check_jobs SET next_run_at = NOW() WHERE check_id = $1", [flakyId]);
      await processDueJobs(pool, options);
      assert.deepEqual([(await job(flakyId)).status, (await job(flakyId)).attempts], ["failed", 3], "gives up after max attempts");

      // ── Metadata-only projects never call a judge ──
      const metaJob = await job(metaJudgeId, `trA_m_${suffix}`);
      assert.deepEqual([metaJob.status, metaJob.skip_reason], ["skipped", "needs_capture"]);
      assert.equal(provider.requests.filter((request) => request.key.includes("meta")).length, 0);
      const metaList = await api("GET", `${metaProject}/quality/checks`);
      assert.equal(metaList.json.textCapture, false);
      assert.equal(metaList.json.checks[0].status, "needs_capture");

      // ── Per-project rate limit defers without spending an attempt ──
      const full = new ProjectRateLimiter(1);
      full.take(textProject);
      await pool.query("UPDATE quality_check_jobs SET status = 'pending', attempts = 0, next_run_at = NOW() WHERE check_id = $1", [judgeId]);
      const [claimed] = await claimDueJobs(pool, 1);
      assert.equal(claimed.checkId, judgeId);
      assert.equal(await processJob(pool, claimed, { ...options, rateLimiter: full }), "deferred");
      const deferred = await job(judgeId);
      assert.deepEqual([deferred.status, deferred.attempts], ["pending", 0]);
      assert.ok(Number(deferred.wait) > 0);
      await pool.query("UPDATE quality_check_jobs SET next_run_at = NOW() WHERE check_id = $1", [judgeId]);
      await processDueJobs(pool, options);
      assert.equal((await job(judgeId)).status, "done");

      // ── Idempotent: re-running and re-upserting keeps one score per check per run ──
      const backfill = await api("POST", `${textProject}/quality/checks/${runSucceededId}/backfill`, {});
      assert.equal(backfill.status, 202);
      assert.equal(backfill.json.queued, 0, "runs inside the default settle delay are not backfilled");
      const check = (await getCheck(pool, textProject, runSucceededId))!;
      assert.deepEqual(await backfillCheck(pool, check, 200, { settleMs: 0 }), { queued: 2 });
      await assert.rejects(backfillCheck(pool, check, 200, { settleMs: 0 }), /already running/);
      await processDueJobs(pool, options);
      const facts = (await loadRunFacts(pool, textProject, traceA))!;
      await upsertCheckScore(pool, check, facts, { value: 1, label: "pass", reason: "again" }, await projectCapture(pool, textProject));
      const counts = await pool.query(
        "SELECT name, COUNT(*)::int AS n FROM scores WHERE project_id = $1 AND left(id, 3) = 'qc:' GROUP BY name ORDER BY name",
        [textProject],
      );
      assert.deepEqual(
        (counts.rows as Array<{ name: string; n: number }>).map((row) => [row.name, row.n]),
        [["Answered the question", 1], ["Latency", 2], ["Retries", 2], ["Run succeeded", 2], ["Tool errors", 2]],
      );

      // ── Renaming keeps history under the new name ──
      const renamed = await api("PATCH", `${textProject}/quality/checks/${runSucceededId}`, { name: "Run OK" });
      assert.equal(renamed.status, 200);
      assert.equal((await score(runSucceededId, traceB))?.name, "Run OK");

      // ── List with period stats ──
      const list = await api("GET", `${textProject}/quality/checks`, undefined, "viewer");
      assert.equal(list.status, 200);
      assert.equal(list.json.canManage, false);
      const listed = new Map((list.json.checks as Array<Record<string, any>>).map((item) => [item.id, item]));
      assert.deepEqual([listed.get(runSucceededId)?.stats.scored, listed.get(runSucceededId)?.stats.passRate], [2, 0.5]);
      assert.equal(listed.get(created.latency)?.stats.avg, 0.75);
      assert.equal(listed.get(badId)?.status, "error");
      assert.ok(!list.text.includes("sk-good") && !list.text.includes("v1."), "no key material in the list");
      assert.equal(list.json.templates.length, 5);
      assert.equal((await api("GET", `${textProject}/quality/checks`, undefined, "admin")).json.canManage, true);

      // ── Disable and per-run results ──
      assert.equal((await api("PATCH", `${textProject}/quality/checks/${created.toolErrors}`, { enabled: false }, "admin")).json.check.enabled, false);
      const ownerRun = await api("GET", `${textProject}/quality/runs/${encodeURIComponent(traceA)}/checks`);
      const byName = new Map((ownerRun.json.results as Array<Record<string, any>>).map((item) => [item.name, item]));
      assert.equal(byName.get("Answered the question")?.state, "passed");
      assert.match(String(byName.get("Answered the question")?.reason), /Answered the order question/);
      assert.equal(byName.get("Latency")?.state, "failed");
      assert.equal(byName.get("Cost per run")?.state, "not_sampled");
      assert.equal(byName.get("Bad key judge")?.state, "error");
      const runB = await api("GET", `${textProject}/quality/runs/${encodeURIComponent(traceB)}/checks`);
      assert.equal((runB.json.results as Array<Record<string, any>>).find((item) => item.name === "Flaky judge")?.state, "not_applicable");
      const viewerRun = await api("GET", `${textProject}/quality/runs/${encodeURIComponent(traceA)}/checks`, undefined, "viewer");
      const viewerJudge = (viewerRun.json.results as Array<Record<string, any>>).find((item) => item.name === "Answered the question");
      assert.equal(viewerJudge?.reason, null, "judge reasons follow content access");
      assert.equal(viewerJudge?.score, 0.8);

      // ── Key update is write-only; delete is owner/admin only ──
      const rotated = await api("PATCH", `${textProject}/quality/checks/${judgeId}`, { apiKey: "sk-good-judge-key-9999" });
      assert.equal(rotated.json.check.keyHint, "9999");
      const cleared = await api("PATCH", `${textProject}/quality/checks/${judgeId}`, { apiKey: null });
      assert.equal(cleared.json.check.hasKey, false);
      assert.equal((await api("DELETE", `${textProject}/quality/checks/${created.unsampled}`)).status, 204);
      assert.equal((await api("GET", `project_missing_${suffix}/quality/checks`)).status, 404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await provider.close();
    for (const projectId of [textProject, metaProject]) {
      for (const table of ["quality_check_jobs", "quality_check_cursors", "quality_checks", "scores", "spans", "events", "usage_components", "traces", "executions", "groups", "project_memberships", "project_settings"]) {
        await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]).catch(() => undefined);
      }
      await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    }
    await pool.query("DELETE FROM users WHERE org_id = $1", [orgId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});
