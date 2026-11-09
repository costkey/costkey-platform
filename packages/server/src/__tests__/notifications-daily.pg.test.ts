import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pg from "pg";
import {
  clearLocalNotificationSink,
  createNotificationsRouter,
  encryptSecret,
  ensureNotificationSchema,
  getLocalNotificationSink,
  maskSlackWebhookUrl,
  runDailySummaries,
  runWeeklyDigests,
} from "../notifications.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { ensurePolicySchema } from "../policy-storage.js";

/**
 * Opt-in PostgreSQL proof for Slack destinations and the daily summary. All
 * delivery goes to the in-process memory sink; nothing leaves the machine.
 */
const connectionString = process.env["COSTKEY_NOTIFICATION_PG_TEST_URL"]
  ?? process.env["COSTKEY_PG_TEST_URL"]
  ?? process.env["PLATFORM_TEST_DATABASE_URL"]
  ?? process.env["ACCEPTANCE_DATABASE_URL"];
const canRun = Boolean(connectionString);
const schemaName = "costkey_notifications_daily_" + process.pid + "_" + Math.random().toString(16).slice(2);
const orgId = "org_daily";
const ownerId = "user_daily_owner";
const memberId = "user_daily_member";
const projectOne = "project_daily_one";
// Synthetic, never a real workspace.
const slackUrl = "https://hooks.slack.com/services/T00DAILY/B00DAILY/dailytokenabcdefghijklmn";
const slackToken = "dailytokenabcdefghijklmn";

let pool: pg.Pool | null = null;
let bootstrap: pg.Pool | null = null;
let server: Server | null = null;
let baseUrl = "";
let currentUser: Record<string, unknown> = {};
const originalEnvironment = new Map<string, string | undefined>();

function setEnvironment(): void {
  for (const key of ["NODE_ENV", "COSTKEY_NOTIFICATION_SINK", "COSTKEY_NOTIFICATION_ENCRYPTION_KEY", "COSTKEY_NOTIFICATION_TEST_DELIVERY", "RESEND_API_KEY"]) {
    originalEnvironment.set(key, process.env[key]);
  }
  process.env["NODE_ENV"] = "test";
  process.env["COSTKEY_NOTIFICATION_SINK"] = "memory";
  process.env["COSTKEY_NOTIFICATION_ENCRYPTION_KEY"] = "notifications-daily-test-key";
  delete process.env["COSTKEY_NOTIFICATION_TEST_DELIVERY"];
  delete process.env["RESEND_API_KEY"];
}

function restoreEnvironment(): void {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnvironment.clear();
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
  await ensurePolicySchema(pool);
  await ensureNotificationSchema(pool);
}

async function seed(): Promise<void> {
  assert.ok(pool);
  await pool.query(`INSERT INTO orgs(id, name, slug) VALUES ($1, 'Daily', 'daily-test')`, [orgId]);
  await pool.query(
    `INSERT INTO users(id, email, name, org_id, role) VALUES
       ($1, 'owner@daily.test', 'Owner', $3, 'owner'),
       ($2, 'member@daily.test', 'Member', $3, 'developer')`,
    [ownerId, memberId, orgId],
  );
  await pool.query(`INSERT INTO projects(id, name, org_id, auth_key) VALUES ($1, 'One', $2, 'auth-daily-one')`, [projectOne, orgId]);
  // Kolkata 2026-09-14 is 2026-09-13T18:30Z .. 2026-09-14T18:30Z; the day before precedes it.
  await pool.query(
    `INSERT INTO events(id, project_id, timestamp, provider, model, cost_usd, cost_basis, cost_source, context, trace_id)
     VALUES
       ('d-1', $1, '2026-09-14T04:00:00Z', 'openai', 'gpt-4o', 6.00, 'reported', 'fixture', '{"feature":"Search"}', 't1'),
       ('d-2', $1, '2026-09-14T05:00:00Z', 'openai', 'gpt-4o-mini', 3.00, 'reported', 'fixture', '{"feature":"Chat"}', 't2'),
       ('d-3', $1, '2026-09-14T06:00:00Z', 'anthropic', 'claude-x', 1.00, 'reported', 'fixture', '{"feature":"Summarize"}', 't3'),
       ('d-4', $1, '2026-09-14T07:00:00Z', 'mistral', 'mystery', NULL, 'unknown', NULL, '{"feature":"Extra"}', 't4'),
       ('d-5', $1, '2026-09-14T08:00:00Z', 'mistral', 'mystery', NULL, 'unknown', NULL, '{"feature":"Extra"}', 't5'),
       ('p-1', $1, '2026-09-13T04:00:00Z', 'openai', 'gpt-4o', 8.00, 'reported', 'fixture', '{"feature":"Search"}', 't6')`,
    [projectOne],
  );
  await pool.query(
    `INSERT INTO spending_policies(id, project_id, name, mode, status, unit, allowance, currency, window_kind, timezone)
     VALUES ('pol-daily', $1, 'Search daily', 'monitor', 'active', 'money', 10, 'USD', 'calendar_day', 'Asia/Kolkata'),
            ('pol-quiet', $1, 'Quiet monthly', 'monitor', 'active', 'money', 1000, 'USD', 'calendar_month', 'Asia/Kolkata')`,
    [projectOne],
  );
  await pool.query(
    `INSERT INTO policy_window_usage(policy_id, window_key, unit, currency, limit_quantity, settled_quantity, observed_quantity)
     VALUES ('pol-daily', '2026-09-14', 'money', 'USD', 10, 9, 0),
            ('pol-quiet', '2026-09', 'money', 'USD', 1000, 10, 0)`,
  );
  await pool.query(
    `INSERT INTO notification_preferences(id, org_id, user_id, project_id, weekly_summary_enabled, timezone, daily_summary_enabled, daily_summary_hour)
     VALUES ('pref-daily-owner', $1, $2, NULL, FALSE, 'Asia/Kolkata', TRUE, 9),
            ('pref-daily-member', $1, $3, NULL, FALSE, 'Asia/Kolkata', FALSE, 9)`,
    [orgId, ownerId, memberId],
  );
  await pool.query(
    `INSERT INTO notification_destinations(id, org_id, project_id, owner_user_id, kind, address, secret_ciphertext, event_types)
     VALUES ('dest-daily-slack', $1, NULL, $2, 'slack', $3, $4, ARRAY['daily_summary','weekly_summary'])`,
    [orgId, ownerId, maskSlackWebhookUrl(slackUrl), encryptSecret(slackUrl)],
  );
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(baseUrl + path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

before(async () => {
  if (!canRun) return;
  setEnvironment();
  bootstrap = new pg.Pool({ connectionString });
  await bootstrap.query("CREATE SCHEMA " + schemaName);
  pool = new pg.Pool({ connectionString, max: 8, options: "-c search_path=" + schemaName });
  await createBaseTables();
  await seed();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = currentUser; next(); });
  app.use(createNotificationsRouter(pool));
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = "http://127.0.0.1:" + address.port;
  currentUser = { id: ownerId, orgId, role: "owner", email: "owner@daily.test" };
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
  restoreEnvironment();
});

test("notification schema extension is idempotent and admits slack destinations", { skip: !canRun }, async () => {
  assert.ok(pool);
  await ensureNotificationSchema(pool);
  await ensurePlatformSchema(pool);
  const columns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'notification_preferences'`,
  );
  const names = new Set(columns.rows.map((row) => String(row.column_name)));
  for (const column of ["daily_summary_enabled", "daily_summary_hour", "budget_alerts_enabled"]) assert.equal(names.has(column), true, column);
  await assert.rejects(pool.query(
    `INSERT INTO notification_destinations(id, org_id, owner_user_id, kind, address) VALUES ('bad-kind', $1, $2, 'sms', 'x')`,
    [orgId, ownerId],
  ));
});

test("daily summary reports yesterday vs the day before, top costs, budgets and unpriced calls once per day", { skip: !canRun }, async () => {
  assert.ok(pool);
  clearLocalNotificationSink();
  // 08:30 IST: not yet due.
  assert.equal(await runDailySummaries(pool, new Date("2026-09-15T03:00:00.000Z")) >= 0, true);
  const early = getLocalNotificationSink().filter((item) => item.headers["X-CostKey-Event"] === "daily_summary");
  // The 14 Sep schedule (reporting 13 Sep) is still inside its 24h window, so allow it, but nothing for 14 Sep yet.
  assert.equal(early.every((item) => !item.body.includes("2026-09-14")), true);
  clearLocalNotificationSink();

  await runDailySummaries(pool, new Date("2026-09-15T03:30:00.000Z"));
  const sent = getLocalNotificationSink();
  const slack = sent.filter((item) => item.url.startsWith("slack://"));
  const email = sent.filter((item) => item.url.startsWith("email://"));
  assert.equal(slack.length, 1);
  assert.equal(email.length, 1);
  assert.equal(email[0].url, "email://" + encodeURIComponent("owner@daily.test"));
  assert.equal(slack[0].url.includes(slackToken), false);
  const message = JSON.parse(slack[0].body) as { text: string; blocks: Array<Record<string, unknown>> };
  const header = (message.blocks[0].text as Record<string, unknown>).text;
  assert.equal(header, "Daily spend · 2026-09-14");
  const section = message.blocks.find((block) => block.type === "section") as Record<string, unknown>;
  const text = String((section.text as Record<string, unknown>).text);
  assert.match(text, /^\$10\.00 yesterday, \+25% vs \$8\.00\./);
  assert.match(text, /Top features: Search \$6\.00, Chat \$3\.00, Summarize \$1\.00\./);
  assert.match(text, /Top models: gpt-4o \$6\.00, gpt-4o-mini \$3\.00, claude-x \$1\.00\./);
  assert.match(text, /1 budget over 80%: Search daily 90%\./);
  assert.match(text, /2 unpriced calls\./);
  assert.equal(text.includes("Quiet monthly"), false);
  const fields = (section.fields as Array<{ text: string }>).map((field) => field.text);
  assert.deepEqual(fields, ["*Yesterday*\n$10.00", "*Change*\n+25%", "*Unpriced calls*\n2"]);
  assert.equal(email[0].body.includes("Daily spend · 2026-09-14"), true);

  // Later hourly runs the same day and a full weekly-worker pass reuse the dedupe key.
  await runDailySummaries(pool, new Date("2026-09-15T12:30:00.000Z"));
  await runWeeklyDigests(pool, new Date("2026-09-15T13:30:00.000Z"));
  assert.equal(getLocalNotificationSink().length, 2);
  const outbox = await pool.query(
    `SELECT destination_id, dedupe_key, status FROM notification_deliveries WHERE event_type = 'daily_summary' ORDER BY destination_id`,
  );
  const forDay = outbox.rows.filter((row) => String(row.dedupe_key).includes("2026-09-13T18:30:00.000Z"));
  assert.equal(forDay.length, 2);
  assert.equal(forDay.every((row) => row.status === "sent"), true);
});

test("Slack destinations: admin-only, strictly validated, stored encrypted and returned masked; test send works", { skip: !canRun }, async () => {
  assert.ok(pool);
  currentUser = { id: memberId, orgId, role: "developer", email: "member@daily.test" };
  const forbidden = await api("POST", "/api/v1/notifications/destinations", { kind: "slack", address: slackUrl, eventTypes: ["daily_summary"] });
  assert.equal(forbidden.status, 403);

  currentUser = { id: ownerId, orgId, role: "owner", email: "owner@daily.test" };
  for (const address of ["https://example.com/services/T1/B1/abcdefghijklmnopqrstuvwx", "https://hooks.slack.com/services/T00DAILY/B00DAILY/x?y=1", "http://hooks.slack.com/services/T00DAILY/B00DAILY/dailytokenabcdefghijklmn"]) {
    const invalid = await api("POST", "/api/v1/notifications/destinations", { kind: "slack", address, eventTypes: ["daily_summary"] });
    assert.equal(invalid.status, 400, address);
  }
  const created = await api("POST", "/api/v1/notifications/destinations", {
    kind: "slack",
    address: slackUrl,
    eventTypes: ["weekly_summary", "daily_summary", "finding", "policy_warning", "enforcement", "execution_receipt"],
  });
  assert.equal(created.status, 201);
  const destination = created.json.destination as Record<string, unknown>;
  assert.equal(destination.kind, "slack");
  assert.equal(JSON.stringify(created.json).includes(slackToken), false);
  assert.equal(destination.secret_ciphertext, undefined);
  assert.deepEqual(destination.event_types, ["weekly_summary", "daily_summary", "finding", "policy_warning", "enforcement", "execution_receipt"]);

  const stored = await pool.query(`SELECT address, secret_ciphertext FROM notification_destinations WHERE id = $1`, [destination.id]);
  assert.equal(String(stored.rows[0].address).includes(slackToken), false);
  assert.equal(String(stored.rows[0].secret_ciphertext).includes(slackToken), false);

  const list = await api("GET", "/api/v1/notifications/destinations");
  assert.equal(list.status, 200);
  assert.equal(JSON.stringify(list.json).includes(slackToken), false);
  assert.equal(JSON.stringify(list.json).includes("secret_ciphertext"), false);

  clearLocalNotificationSink();
  const tested = await api("POST", "/api/v1/notifications/destinations/" + String(destination.id) + "/test");
  assert.equal(tested.status, 200);
  assert.equal((tested.json.delivery as Record<string, unknown>).status, "sent");
  const item = getLocalNotificationSink().at(-1);
  assert.ok(item);
  assert.match(item.url, /^slack:\/\//);
  const body = JSON.parse(item.body) as { blocks: Array<Record<string, unknown>> };
  assert.equal((body.blocks[0].text as Record<string, unknown>).text, "CostKey channel test");
});

test("preferences expose daily summary and an independent budget alert switch", { skip: !canRun }, async () => {
  currentUser = { id: memberId, orgId, role: "developer", email: "member@daily.test" };
  const initial = await api("GET", "/api/v1/notifications/preferences");
  const preferences = initial.json.preferences as Record<string, unknown>;
  assert.equal(preferences.dailySummaryEnabled, false);
  assert.equal(preferences.dailySummaryHour, 9);
  assert.equal(preferences.budgetAlertsEnabled, true);

  assert.equal((await api("PATCH", "/api/v1/notifications/preferences", { dailySummaryHour: 24 })).status, 400);
  assert.equal((await api("PATCH", "/api/v1/notifications/preferences", { dailySummaryEnabled: "yes" })).status, 400);

  const updated = await api("PATCH", "/api/v1/notifications/preferences", { dailySummaryEnabled: true, dailySummaryHour: 7 });
  assert.equal(updated.status, 200);
  assert.equal((updated.json.preferences as Record<string, unknown>).dailySummaryEnabled, true);
  assert.equal((updated.json.preferences as Record<string, unknown>).dailySummaryHour, 7);

  // Muting refusals keeps budget alerts on.
  const muted = await api("PATCH", "/api/v1/notifications/preferences", { enforcementEnabled: false });
  assert.equal((muted.json.preferences as Record<string, unknown>).enforcementEnabled, false);
  assert.equal((muted.json.preferences as Record<string, unknown>).budgetAlertsEnabled, true);
  const budgetsOff = await api("PATCH", "/api/v1/notifications/preferences", { budgetAlertsEnabled: false });
  assert.equal((budgetsOff.json.preferences as Record<string, unknown>).budgetAlertsEnabled, false);
});
