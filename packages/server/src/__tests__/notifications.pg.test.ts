import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import pg from "pg";
import {
  dispatchFindingNotification,
  dispatchNotification,
  dispatchPolicyWarning,
  dispatchWebhook,
  encryptSecret,
  runFindingNotifications,
  retryNotificationDeliveries,
  runWeeklyDigests,
  verifyWebhookSignature,
} from "../notifications.js";
import { ensurePlatformSchema } from "../platform-storage.js";

/**
 * Opt-in integration proof against an isolated PostgreSQL schema. The
 * notification tables are created only by the platform storage owner; the
 * fixture creates only the legacy/accounting base tables needed by that
 * startup migration and canonical charge cohort.
 */
const connectionString = process.env["COSTKEY_NOTIFICATION_PG_TEST_URL"]
  ?? process.env["COSTKEY_PG_TEST_URL"]
  ?? process.env["ACCEPTANCE_DATABASE_URL"];
const canRun = Boolean(connectionString);
const schemaName = "costkey_notifications_" + process.pid + "_" + Math.random().toString(16).slice(2);
const orgId = "org_notification_pg";
const ownerId = "user_notification_owner";
const memberId = "user_notification_member";
const projectOne = "project_notification_one";
const projectTwo = "project_notification_two";
const projectThree = "project_notification_three";
const webhookSecret = "notification-pg-webhook-secret";

let pool: pg.Pool | null = null;
let bootstrap: pg.Pool | null = null;
let server: Server | null = null;
let webhookUrl = "";
let statusQueue: number[] = [];
let requests: Array<{ body: string; deliveryId?: string; timestamp?: string; signature?: string }> = [];
const originalEnvironment = new Map<string, string | undefined>();

function setNotificationTestEnvironment(): void {
  for (const key of [
    "NODE_ENV",
    "COSTKEY_NOTIFICATION_TEST_ALLOW_LOOPBACK",
    "COSTKEY_NOTIFICATION_TEST_DELIVERY",
    "COSTKEY_NOTIFICATION_SINK",
    "COSTKEY_NOTIFICATION_ENCRYPTION_KEY",
    "RESEND_API_KEY",
  ]) originalEnvironment.set(key, process.env[key]);
  process.env["NODE_ENV"] = "test";
  process.env["COSTKEY_NOTIFICATION_TEST_ALLOW_LOOPBACK"] = "1";
  process.env["COSTKEY_NOTIFICATION_TEST_DELIVERY"] = "1";
  delete process.env["COSTKEY_NOTIFICATION_SINK"];
  process.env["COSTKEY_NOTIFICATION_ENCRYPTION_KEY"] = "notifications-pg-test-key";
  delete process.env["RESEND_API_KEY"];
}

function restoreNotificationTestEnvironment(): void {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnvironment.clear();
}

async function startWebhookSink(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        body: Buffer.concat(chunks).toString("utf8"),
        deliveryId: typeof request.headers["x-costkey-delivery"] === "string"
          ? request.headers["x-costkey-delivery"]
          : undefined,
        timestamp: typeof request.headers["x-costkey-timestamp"] === "string"
          ? request.headers["x-costkey-timestamp"]
          : undefined,
        signature: typeof request.headers["x-costkey-signature"] === "string"
          ? request.headers["x-costkey-signature"]
          : undefined,
      });
      response.statusCode = statusQueue.shift() ?? 202;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  webhookUrl = "http://127.0.0.1:" + address.port + "/notifications";
}

async function createBaseTables(): Promise<void> {
  assert.ok(pool);
  await pool.query(`
    CREATE TABLE orgs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      name TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES orgs(id),
      role TEXT NOT NULL DEFAULT 'developer',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES orgs(id),
      auth_key TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id),
      project_id TEXT REFERENCES projects(id),
      type TEXT NOT NULL,
      threshold DOUBLE PRECISION,
      channel TEXT NOT NULL DEFAULT 'webhook',
      webhook_url TEXT,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE team_invites (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id),
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'developer',
      invited_by TEXT NOT NULL REFERENCES users(id),
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      provider TEXT NOT NULL DEFAULT 'test-provider',
      model TEXT,
      request_model TEXT,
      pricing_id TEXT,
      feature_source TEXT,
      feature_mapping_id TEXT,
      feature_mapping_action_id TEXT,
      feature_original TEXT,
      cost_usd DOUBLE PRECISION,
      cost_basis TEXT NOT NULL DEFAULT 'reported',
      cost_source TEXT,
      cost_currency TEXT NOT NULL DEFAULT 'USD',
      duration_ms DOUBLE PRECISION,
      trace_id TEXT,
      trace_name TEXT,
      context JSONB,
      execution_id TEXT,
      group_id TEXT,
      group_name TEXT,
      group_kind TEXT,
      phase TEXT,
      case_id TEXT,
      event_type TEXT NOT NULL DEFAULT 'call',
      source TEXT NOT NULL DEFAULT 'auto',
      charge_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      bl_file TEXT,
      bl_function TEXT,
      bl_line INTEGER,
      release TEXT,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      reasoning_tokens INTEGER,
      lifecycle_state TEXT,
      status_code INTEGER
    );
    CREATE TABLE usage_components (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      charge_id TEXT,
      component_id TEXT,
      caller_id TEXT,
      pricing_id TEXT,
      context JSONB,
      trace_id TEXT,
      execution_id TEXT,
      group_id TEXT,
      phase TEXT,
      component TEXT NOT NULL DEFAULT 'custom',
      provider TEXT NOT NULL DEFAULT 'test-provider',
      model TEXT,
      unit_kind TEXT,
      unit_value DOUBLE PRECISION,
      unit TEXT,
      amount DOUBLE PRECISION,
      currency TEXT NOT NULL DEFAULT 'USD',
      amount_kind TEXT NOT NULL DEFAULT 'reported',
      aggregation TEXT NOT NULL DEFAULT 'delta',
      revision INTEGER,
      payload_hash TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      accounting_at TIMESTAMPTZ,
      observed_at TIMESTAMPTZ NOT NULL,
      metadata JSONB
    );
    CREATE TABLE findings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      family TEXT NOT NULL,
      scope JSONB NOT NULL DEFAULT '{}'::JSONB,
      state TEXT NOT NULL DEFAULT 'new',
      observed_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      baseline JSONB,
      evidence JSONB NOT NULL DEFAULT '{}'::JSONB
    );
    CREATE TABLE budget_alert_firings (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      threshold DOUBLE PRECISION NOT NULL,
      window_key TEXT NOT NULL,
      fired_at TIMESTAMPTZ DEFAULT NOW(),
      spent_usd DOUBLE PRECISION NOT NULL,
      limit_usd DOUBLE PRECISION NOT NULL
    );
    CREATE TABLE executions (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      group_id TEXT,
      name TEXT,
      state TEXT NOT NULL DEFAULT 'completed',
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      PRIMARY KEY (project_id, id)
    );
  `);
  await ensurePlatformSchema(pool);
  await ensurePlatformSchema(pool);
}

async function seedFixtures(): Promise<void> {
  assert.ok(pool);
  await pool.query(
    `INSERT INTO orgs(id, name, slug) VALUES ($1, 'Notification test', 'notification-pg-test')`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO users(id, email, name, org_id, role) VALUES
       ($1, 'owner@notification.test', 'Owner', $3, 'owner'),
       ($2, 'member@notification.test', 'Member', $3, 'developer')`,
    [ownerId, memberId, orgId],
  );
  await pool.query(
    `INSERT INTO projects(id, name, org_id, auth_key) VALUES
       ($1, 'One', $4, 'auth-one'),
       ($2, 'Two', $4, 'auth-two'),
       ($3, 'Three', $4, 'auth-three')`,
    [projectOne, projectTwo, projectThree, orgId],
  );
  await pool.query(
    `INSERT INTO project_memberships(project_id, user_id, assigned_by) VALUES ($1, $2, $3)`,
    [projectOne, memberId, ownerId],
  );
  const observedAt = "2026-09-08T02:00:00.000Z";
  await pool.query(
    `INSERT INTO events(id, project_id, timestamp, provider, model, cost_usd, cost_basis, cost_source, context, trace_id, trace_name)
     VALUES
       ('event-one', $1, $4, 'openai', 'gpt-4o', 1.00, 'reported', 'pg-fixture', '{"feature":"Search"}', 'trace-one', 'search'),
       ('event-two-a', $2, $4, 'openai', 'gpt-4o', 2.00, 'reported', 'pg-fixture', '{"feature":"Search"}', 'trace-two-a', 'search'),
       ('event-two-b', $2, $4, 'openai', 'gpt-4o', 3.00, 'reported', 'pg-fixture', '{"feature":"Search"}', 'trace-two-b', 'search'),
       ('event-three', $3, $4, 'openai', 'gpt-4o', 4.00, 'reported', 'pg-fixture', '{}', 'trace-three', 'unassigned')`,
    [projectOne, projectTwo, projectThree, observedAt],
  );
  await pool.query(
    `INSERT INTO findings(id, project_id, family, scope, observed_at, last_seen_at, evidence)
     VALUES ('finding-one', $1, 'increased_unit_cost', '{"dimension":"feature","value":"Search"}', $2, $2, '{"absoluteDifference":1.25,"relativeDifference":0.5,"traceId":"trace-one","prompt":"private"}')`,
    [projectOne, observedAt],
  );
  await pool.query(
    `INSERT INTO budget_alert_firings(id, rule_id, project_id, scope, threshold, window_key, fired_at, spent_usd, limit_usd)
     VALUES ('firing-one', 'policy-summary', $1, 'daily', 0.8, '2026-09-08', $2, 8, 10)`,
    [projectOne, observedAt],
  );
  await pool.query(
    `INSERT INTO notification_preferences(
       id, org_id, user_id, project_id, weekly_summary_enabled,
       weekly_summary_hour, weekly_summary_weekday, timezone,
       findings_enabled, policy_warning_thresholds, enforcement_enabled, execution_receipts_enabled
     ) VALUES
       ('pref-owner-workspace', $1, $2, NULL, TRUE, 9, 1, 'Asia/Kolkata', FALSE, ARRAY[0.8, 1.0], TRUE, FALSE),
       ('pref-member-workspace', $1, $3, NULL, TRUE, 9, 1, 'Asia/Kolkata', FALSE, ARRAY[0.8, 1.0], TRUE, FALSE),
       ('pref-member-project', $1, $3, $4, FALSE, 9, 1, 'Asia/Kolkata', FALSE, ARRAY[0.8, 1.0], TRUE, FALSE)`,
    [orgId, ownerId, memberId, projectOne],
  );
  const encrypted = encryptSecret(webhookSecret);
  assert.ok(encrypted);
  await pool.query(
    `INSERT INTO notification_destinations(id, org_id, project_id, owner_user_id, kind, address, secret_ciphertext, event_types)
     VALUES
       ('destination-owner-workspace', $1, NULL, $2, 'webhook', $5, $6, ARRAY['weekly_summary','policy_warning','enforcement','finding','execution_receipt']),
       ('destination-member-workspace', $1, NULL, $3, 'webhook', $5, $6, ARRAY['weekly_summary']),
       ('destination-member-project', $1, $4, $3, 'webhook', $5, $6, ARRAY['enforcement']),
       ('destination-owner-email', $1, $7, $2, 'email', 'owner@notification.test', NULL, ARRAY['enforcement'])`,
    [orgId, ownerId, memberId, projectOne, webhookUrl, encrypted, projectTwo],
  );
}

async function queryOne<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  assert.ok(pool);
  const result = await pool.query(sql, params);
  assert.ok(result.rows[0]);
  return result.rows[0] as T;
}

before(async () => {
  if (!canRun) return;
  setNotificationTestEnvironment();
  bootstrap = new pg.Pool({ connectionString });
  await bootstrap.query("CREATE SCHEMA " + schemaName);
  pool = new pg.Pool({ connectionString, max: 8, options: "-c search_path=" + schemaName });
  await createBaseTables();
  await startWebhookSink();
  await seedFixtures();
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  if (pool) await pool.end();
  pool = null;
  if (bootstrap) {
    await bootstrap.query("DROP SCHEMA IF EXISTS " + schemaName + " CASCADE");
    await bootstrap.end();
  }
  bootstrap = null;
  restoreNotificationTestEnvironment();
});

test("platform startup creates the exact notification tables and indexes", { skip: !canRun }, async () => {
  assert.ok(pool);
  const columns = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name IN ('notification_destinations','notification_preferences','notification_deliveries')`,
  );
  const names = new Set(columns.rows.map((row) => String(row.table_name) + "." + String(row.column_name)));
  for (const required of [
    "notification_destinations.secret_ciphertext",
    "notification_destinations.event_types",
    "notification_destinations.enabled",
    "notification_preferences.weekly_summary_enabled",
    "notification_preferences.weekly_summary_hour",
    "notification_preferences.weekly_summary_weekday",
    "notification_preferences.timezone",
    "notification_preferences.findings_enabled",
    "notification_preferences.execution_receipts_enabled",
    "notification_deliveries.user_id",
    "notification_deliveries.dedupe_key",
    "notification_deliveries.attempt_count",
    "notification_deliveries.status",
  ]) assert.equal(names.has(required), true, "missing platform column " + required);
  const indexes = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
  );
  const indexNames = new Set(indexes.rows.map((row) => String(row.indexname)));
  assert.equal(indexNames.has("idx_notification_preferences_due"), true);
  assert.equal(indexNames.has("idx_notification_deliveries_dedupe"), true);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM notification_preferences")).rows[0].count, 3);
});

test("weekly summaries use recipient timezone and assigned projects without fanout", { skip: !canRun }, async () => {
  requests = [];
  statusQueue = [202, 202];
  const count = await runWeeklyDigests(pool!, new Date("2026-09-14T03:30:00.000Z"));
  assert.ok(count >= 2);
  assert.equal(requests.length, 2);
  const summaries = requests.map((request) => JSON.parse(request.body) as Record<string, unknown>);
  const calls = summaries.map((summary) => Number((summary.evidence as Record<string, unknown>).calls)).sort((a, b) => a - b);
  assert.deepEqual(calls, [1, 4]);
  for (const summary of summaries) {
    assert.equal(summary.projectId, null);
    assert.equal(JSON.stringify(summary).toLowerCase().includes("prompt"), false);
    assert.equal(JSON.stringify(summary).toLowerCase().includes("auth_key"), false);
    assert.equal(JSON.stringify(summary).toLowerCase().includes("source"), false);
  }
  assert.equal(
    requests.every((request) => request.timestamp && request.signature && verifyWebhookSignature(webhookSecret, request.timestamp, request.body, request.signature)),
    true,
  );
  await runWeeklyDigests(pool!, new Date("2026-09-15T03:30:00.000Z"));
  assert.equal(requests.length, 2, "a repeated scheduler after downtime must reuse the weekly outbox dedupe key");
});

test("high-volume weekly summaries return bounded SQL aggregates, not raw charge arrays", { skip: !canRun }, async () => {
  assert.ok(pool);
  await pool.query(
    `INSERT INTO events(id, project_id, timestamp, provider, model, cost_usd, cost_basis, cost_source, context, trace_id)
     SELECT 'scale-event-' || n::text, $1, '2026-09-15T02:00:00.000Z'::timestamptz + (n || ' seconds')::interval,
            'openai', 'gpt-4o', 0.001, 'reported', 'pg-scale',
            '{"feature":"Scale"}'::jsonb, 'scale-trace-' || n::text
     FROM generate_series(1, 20000) AS n`,
    [projectTwo],
  );
  requests = [];
  statusQueue = [202, 202];
  await runWeeklyDigests(pool, new Date("2026-09-21T03:30:00.000Z"));
  assert.equal(requests.length, 2);
  const summaries = requests.map((request) => JSON.parse(request.body) as Record<string, unknown>);
  const calls = summaries.map((summary) => Number((summary.evidence as Record<string, unknown>).calls)).sort((a, b) => a - b);
  assert.deepEqual(calls, [0, 20000]);
  assert.equal(Math.max(...requests.map((request) => request.body.length)) < 10_000, true);
});

test("persisted findings notify only when scoped findings are enabled", { skip: !canRun }, async () => {
  assert.ok(pool);
  await pool.query("UPDATE findings SET state = 'acknowledged' WHERE id = 'finding-one'");
  await pool.query(
    `INSERT INTO findings(id, project_id, family, scope, state, observed_at, last_seen_at, evidence)
     VALUES ('finding-enabled', $1, 'increased_unit_cost', '{"dimension":"feature","value":"Search"}', 'new', NOW(), NOW(), '{"currentUnitCost":0.15,"previousUnitCost":0.08,"relativeDifference":0.875,"prompt":"private"}')`,
    [projectTwo],
  );
  await pool.query("UPDATE notification_preferences SET findings_enabled = TRUE WHERE id = 'pref-owner-workspace'");
  requests = [];
  statusQueue = [202];
  const first = await runFindingNotifications(pool);
  assert.ok(first >= 1);
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(JSON.parse(requests[0].body)).toLowerCase().includes("prompt"), false);
  await runFindingNotifications(pool);
  assert.equal(requests.length, 1, "the same finding evidence must be outbox-idempotent");

  await pool.query("UPDATE notification_preferences SET findings_enabled = FALSE WHERE id = 'pref-owner-workspace'");
  await pool.query(
    `INSERT INTO findings(id, project_id, family, scope, state, observed_at, last_seen_at, evidence)
     VALUES ('finding-disabled', $1, 'coverage_deterioration', '{"dimension":"project","value":"project-two"}', 'new', NOW(), NOW(), '{"pricingDrop":0.2}')`,
    [projectTwo],
  );
  requests = [];
  const disabled = await runFindingNotifications(pool);
  assert.ok(disabled >= 1);
  assert.equal(requests.length, 0);
  await pool.query("UPDATE notification_preferences SET findings_enabled = TRUE WHERE id = 'pref-owner-workspace'");
  requests = [];
  statusQueue = [202];
  await runFindingNotifications(pool);
  assert.equal(requests.length, 1, "enabling the scoped preference must permit a previously suppressed finding");
  await pool.query("UPDATE notification_preferences SET findings_enabled = FALSE WHERE id = 'pref-owner-workspace'");
});

test("competing workers produce one signed delivery and one outbox row", { skip: !canRun }, async () => {
  requests = [];
  statusQueue = [202];
  const payload = {
    eventType: "enforcement" as const,
    orgId,
    projectId: projectTwo,
    recipientUserId: ownerId,
    title: "Call refused",
    message: "The policy refused the next call.",
    evidence: { policyId: "policy-concurrent", status: "refused", reason: "budget_exhausted" },
    scope: { policyId: "policy-concurrent", reason: "budget_exhausted", traceId: "trace-concurrent" },
    occurredAt: "2026-09-14T03:35:00.000Z",
  };
  const results = await Promise.all([dispatchNotification(pool!, payload), dispatchNotification(pool!, payload)]);
  assert.equal(requests.length, 1);
  assert.equal(results.flat().filter((result) => result.status === "sent").length, 1);
  const row = await queryOne<{ status: string; attempt_count: number; destination_id: string }>(
    `SELECT status, attempt_count, destination_id
     FROM notification_deliveries
     WHERE destination_id = 'destination-owner-workspace'
       AND dedupe_key LIKE 'enforcement:%policy-concurrent:%'
     LIMIT 1`,
  );
  assert.equal(row.status, "sent");
  assert.equal(Number(row.attempt_count), 1);
});

test("failed deliveries retry with a stable id and stop at the bounded attempt count", { skip: !canRun }, async () => {
  requests = [];
  statusQueue = [503, 200];
  const payload = {
    eventType: "enforcement" as const,
    orgId,
    projectId: projectTwo,
    recipientUserId: ownerId,
    title: "Retryable refusal",
    message: "The policy refused the next call.",
    evidence: { policyId: "policy-retry", status: "refused", reason: "budget_exhausted" },
    scope: { policyId: "policy-retry", reason: "budget_exhausted", traceId: "trace-retry" },
    occurredAt: "2026-09-14T03:40:00.000Z",
  };
  const first = await dispatchNotification(pool!, payload);
  assert.equal(first.find((result) => result.status === "failed")?.status, "failed");
  const firstDeliveryId = requests[0]?.deliveryId;
  assert.ok(firstDeliveryId);
  assert.equal(await retryNotificationDeliveries(pool!, new Date(Date.now() + 120_000)), 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.deliveryId, firstDeliveryId);
  const sent = await queryOne<{ status: string; attempt_count: number }>(
    `SELECT status, attempt_count FROM notification_deliveries
     WHERE destination_id = 'destination-owner-workspace'
       AND dedupe_key LIKE 'enforcement:%policy-retry:%'`,
  );
  assert.equal(sent.status, "sent");
  assert.equal(Number(sent.attempt_count), 2);

  requests = [];
  statusQueue = [503, 503, 503];
  const boundedPayload = { ...payload, scope: { policyId: "policy-bounded", reason: "budget_exhausted" }, evidence: { policyId: "policy-bounded", status: "refused", reason: "budget_exhausted" }, occurredAt: "2026-09-14T03:45:00.000Z" };
  await dispatchNotification(pool!, boundedPayload);
  assert.equal(await retryNotificationDeliveries(pool!, new Date(Date.now() + 120_000)), 1);
  assert.equal(await retryNotificationDeliveries(pool!, new Date(Date.now() + 600_000)), 1);
  assert.equal(await retryNotificationDeliveries(pool!, new Date(Date.now() + 1_200_000)), 0);
  assert.equal(requests.length, 3);
  const bounded = await queryOne<{ status: string; attempt_count: number }>(
    `SELECT status, attempt_count FROM notification_deliveries
     WHERE destination_id = 'destination-owner-workspace'
       AND dedupe_key LIKE 'enforcement:%policy-bounded:%'`,
  );
  assert.equal(bounded.status, "failed");
  assert.equal(Number(bounded.attempt_count), 3);
});

test("Resend returned errors remain failed and do not claim acceptance", { skip: !canRun }, async () => {
  assert.ok(pool);
  await pool.query("UPDATE notification_destinations SET enabled = FALSE WHERE id = 'destination-owner-workspace'");
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ name: "bad_request", message: "provider rejected", statusCode: 400 }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  process.env["RESEND_API_KEY"] = "re_fake_key";
  try {
    const results = await dispatchNotification(pool, {
      eventType: "enforcement",
      orgId,
      projectId: projectTwo,
      recipientUserId: ownerId,
      title: "Email failure",
      message: "The policy refused the next call.",
      evidence: { policyId: "policy-resend", status: "refused", reason: "budget_exhausted" },
      scope: { policyId: "policy-resend", reason: "budget_exhausted" },
      occurredAt: "2026-09-14T03:50:00.000Z",
    });
    assert.equal(calls.length, 1);
    assert.equal(results.some((result) => result.status === "failed"), true);
    const row = await queryOne<{ status: string; sent_at: string | null }>(
      `SELECT status, sent_at FROM notification_deliveries
       WHERE destination_id = 'destination-owner-email'
         AND dedupe_key LIKE 'enforcement:%policy-resend:%'`,
    );
    assert.equal(row.status, "failed");
    assert.equal(row.sent_at, null);
    assert.equal(calls[0].toLowerCase().includes("prompt"), false);
    assert.equal(calls[0].toLowerCase().includes("source"), false);
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env["RESEND_API_KEY"];
    await pool.query("UPDATE notification_destinations SET enabled = TRUE WHERE id = 'destination-owner-workspace'");
  }
});

test("warning thresholds are once per scope/window and refusals group by hour", { skip: !canRun }, async () => {
  requests = [];
  statusQueue = [202, 202, 202, 202];
  await dispatchPolicyWarning(pool!, { orgId, projectId: projectTwo, policyId: "policy-warning", threshold: 0.8, windowKey: "2026-09-14", allowance: 10, observedUsage: 8 });
  await dispatchPolicyWarning(pool!, { orgId, projectId: projectTwo, policyId: "policy-warning", threshold: 0.8, windowKey: "2026-09-14", allowance: 10, observedUsage: 8.5 });
  await dispatchPolicyWarning(pool!, { orgId, projectId: projectTwo, policyId: "policy-warning", threshold: 1, windowKey: "2026-09-14", allowance: 10, observedUsage: 10 });
  assert.equal(requests.length, 2);

  const base = {
    eventType: "enforcement" as const,
    orgId,
    projectId: projectTwo,
    recipientUserId: ownerId,
    title: "Immediate refusal",
    message: "The first refusal is immediate.",
    evidence: { policyId: "policy-hourly", status: "refused", reason: "budget_exhausted" },
    scope: { policyId: "policy-hourly", reason: "budget_exhausted" },
  };
  await dispatchNotification(pool!, { ...base, scope: { ...base.scope, traceId: "trace-hour-one" }, occurredAt: "2026-09-14T03:10:00.000Z" });
  await dispatchNotification(pool!, { ...base, scope: { ...base.scope, traceId: "trace-hour-two" }, occurredAt: "2026-09-14T03:45:00.000Z" });
  await dispatchNotification(pool!, { ...base, scope: { ...base.scope, traceId: "trace-hour-three" }, occurredAt: "2026-09-14T04:00:00.000Z" });
  assert.equal(requests.length, 4);
});

test("finding and execution notifications remain default-off", { skip: !canRun }, async () => {
  requests = [];
  statusQueue = [202, 202];
  const finding = await dispatchFindingNotification(pool!, {
    orgId,
    projectId: projectTwo,
    findingId: "finding-default-off",
    title: "Finding",
    message: "A finding needs review.",
    evidence: { cost: 2, prompt: "private" },
  });
  const execution = await dispatchNotification(pool!, {
    eventType: "execution_receipt",
    orgId,
    projectId: projectTwo,
    recipientUserId: ownerId,
    title: "Execution digest",
    message: "A grouped execution completed.",
    evidence: { executionCount: 1, cost: 1 },
    scope: { groupId: "group-default-off" },
    occurredAt: "2026-09-14T04:10:00.000Z",
  });
  assert.equal(requests.length, 0);
  assert.equal(finding.every((result) => result.status === "suppressed"), true);
  assert.equal(execution.every((result) => result.status === "suppressed"), true);
});

test("revoked project access suppresses a queued retry before sending", { skip: !canRun }, async () => {
  assert.ok(pool);
  requests = [];
  statusQueue = [503, 202];
  const payload = {
    eventType: "enforcement" as const,
    orgId,
    projectId: projectOne,
    recipientUserId: memberId,
    title: "Member refusal",
    message: "A project policy refused the next call.",
    evidence: { policyId: "policy-revoked", status: "refused", reason: "budget_exhausted" },
    scope: { policyId: "policy-revoked", reason: "budget_exhausted" },
    occurredAt: "2026-09-14T04:20:00.000Z",
  };
  const first = await dispatchNotification(pool, payload);
  assert.equal(first.some((result) => result.status === "failed"), true);
  assert.equal(requests.length, 1);
  await pool.query("DELETE FROM project_memberships WHERE project_id = $1 AND user_id = $2", [projectOne, memberId]);
  assert.ok((await retryNotificationDeliveries(pool, new Date(Date.now() + 120_000))) >= 1);
  assert.equal(requests.length, 1);
  const row = await queryOne<{ status: string }>(
    `SELECT status FROM notification_deliveries
     WHERE destination_id = 'destination-member-project'
       AND dedupe_key LIKE 'enforcement:%policy-revoked:%'`,
  );
  assert.equal(row.status, "suppressed");
});
