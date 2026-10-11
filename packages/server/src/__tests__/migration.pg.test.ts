import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";

const connectionString = process.env["MIGRATION_TEST_DATABASE_URL"] ?? process.env["COSTKEY_PG_TEST_URL"];
const schemaName = `costkey_migration_${process.pid}_${randomBytes(5).toString("hex")}`;

let admin: pg.Pool | null = null;
let pool: pg.Pool | null = null;
let initDatabase: (() => Promise<void>) | null = null;
let ensurePlatformSchema: ((pool: pg.Pool) => Promise<void>) | null = null;
let ensurePolicySchema: ((pool: pg.Pool) => Promise<void>) | null = null;
let initAnomalyTable: ((pool: pg.Pool) => Promise<void>) | null = null;
let runOnce: ((pool: pg.Pool, name: string, fn: () => Promise<void>) => Promise<void>) | null = null;
const createdPublicTables: string[] = [];

before(async () => {
  if (!connectionString) return;
  admin = new pg.Pool({ connectionString });
  const publicTables = await admin.query(`
    SELECT to_regclass('public.project_budgets') AS project_budgets,
           to_regclass('public.budget_alert_firings') AS budget_alert_firings
  `);
  if (!publicTables.rows[0]?.project_budgets) {
    await admin.query(`
      CREATE TABLE public.project_budgets (
        project_id TEXT PRIMARY KEY,
        daily_usd DOUBLE PRECISION,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    createdPublicTables.push("project_budgets");
  }
  if (!publicTables.rows[0]?.budget_alert_firings) {
    await admin.query(`
      CREATE TABLE public.budget_alert_firings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        threshold DOUBLE PRECISION NOT NULL,
        window_key TEXT NOT NULL,
        fired_at TIMESTAMPTZ DEFAULT NOW(),
        spent_usd DOUBLE PRECISION NOT NULL,
        limit_usd DOUBLE PRECISION NOT NULL
      )
    `);
    createdPublicTables.push("budget_alert_firings");
  }
  if (createdPublicTables.includes("project_budgets")) {
    await admin.query("INSERT INTO public.project_budgets(project_id,daily_usd) VALUES ($1,5) ON CONFLICT DO NOTHING", [`public-${schemaName}`]);
  }
  if (createdPublicTables.includes("budget_alert_firings")) {
    await admin.query("INSERT INTO public.budget_alert_firings(id,project_id,scope,threshold,window_key,spent_usd,limit_usd) VALUES ($1,$2,'daily',0.8,'public',4,5) ON CONFLICT DO NOTHING", [`public-${schemaName}`, `public-${schemaName}`]);
  }
  await admin.query(`CREATE SCHEMA "${schemaName}"`);
  const scoped = new URL(connectionString);
  scoped.searchParams.set("options", `-c search_path=${schemaName}`);
  process.env["DATABASE_URL"] = scoped.toString();
  ({ initDatabase, runOnce } = await import("../db.js"));
  ({ ensurePlatformSchema } = await import("../platform-storage.js"));
  ({ ensurePolicySchema } = await import("../policy-storage.js"));
  ({ initAnomalyTable } = await import("../anomaly.js"));
  pool = (await import("../db.js")).getPool();
});

after(async () => {
  await pool?.end();
  for (const table of createdPublicTables.reverse()) await admin?.query(`DROP TABLE IF EXISTS public.${table}`);
  await admin?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await admin?.end();
});

test("fresh bootstrap and concurrent schema ensures are idempotent", { skip: !connectionString }, async () => {
  assert.ok(initDatabase && pool && ensurePlatformSchema && ensurePolicySchema && initAnomalyTable);
  await initDatabase();
  await Promise.all([initDatabase(), initDatabase()]);
  await Promise.all([ensurePlatformSchema(pool), ensurePlatformSchema(pool)]);
  await Promise.all([ensurePolicySchema(pool), ensurePolicySchema(pool)]);
  await Promise.all([initAnomalyTable(pool), initAnomalyTable(pool)]);

  const eventPk = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'events'::regclass AND contype = 'p'
  `);
  assert.equal(eventPk.rows[0]?.definition, "PRIMARY KEY (project_id, id)");
});

test("legacy budget data is upgraded before the new firing index", { skip: !connectionString }, async () => {
  assert.ok(initDatabase && pool);
  await pool.query("DROP INDEX idx_budget_alert_fired_once");
  await pool.query("DROP TABLE budget_alert_firings");
  await pool.query("DROP TABLE budget_rules");
  await pool.query(`
    CREATE TABLE project_budgets (
      project_id TEXT PRIMARY KEY,
      daily_usd DOUBLE PRECISION, monthly_usd DOUBLE PRECISION,
      calls_per_minute INTEGER, tokens_per_minute INTEGER,
      on_exceed TEXT NOT NULL DEFAULT 'warn', alert_email TEXT,
      alert_webhook_url TEXT,
      alert_thresholds DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[0.5,0.8,1.0],
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE budget_alert_firings (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope TEXT NOT NULL,
      threshold DOUBLE PRECISION NOT NULL, window_key TEXT NOT NULL,
      fired_at TIMESTAMPTZ DEFAULT NOW(), spent_usd DOUBLE PRECISION NOT NULL,
      limit_usd DOUBLE PRECISION NOT NULL
    );
  `);
  const orgId = `org_budget_${randomBytes(4).toString("hex")}`;
  const projectId = `project_budget_${randomBytes(4).toString("hex")}`;
  await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [orgId, "Budget", orgId]);
  await pool.query("INSERT INTO users(id,email,password_hash,name,org_id,role) VALUES ($1,$2,'x','Owner',$3,'owner')", [`u_budget_${orgId}`, `owner-${orgId}@example.invalid`, orgId]);
  await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,$2,$3,$4)", [projectId, "Budget", orgId, `${projectId}-key`]);
  await pool.query("INSERT INTO project_budgets(project_id,daily_usd) VALUES ($1,5)", [projectId]);
  await pool.query("INSERT INTO budget_alert_firings(id,project_id,scope,threshold,window_key,spent_usd,limit_usd) VALUES ($1,$2,$3,$4,$5,$6,$7)", ["legacy-fire", projectId, "daily", 0.8, "today", 4, 5]);

  await initDatabase();
  const firing = await pool.query("SELECT rule_id,project_id FROM budget_alert_firings WHERE id = $1", ["legacy-fire"]);
  assert.equal(firing.rows[0]?.project_id, projectId);
  assert.match(String(firing.rows[0]?.rule_id), /^rule_legacy_/);
  assert.equal((await pool.query("SELECT to_regclass('project_budgets') AS table_name")).rows[0]?.table_name, null);
});

test("one-shot migration failures stay retryable and concurrent runs execute once", { skip: !connectionString }, async () => {
  assert.ok(pool && runOnce);
  await assert.rejects(
    runOnce(pool, "migration_failure_test", async () => { throw new Error("synthetic migration failure"); }),
    /synthetic migration failure/,
  );
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM migrations WHERE name = $1", ["migration_failure_test"])).rows[0]?.count, 0);
  let executions = 0;
  await Promise.all([
    runOnce(pool, "migration_race_test", async () => { executions += 1; }),
    runOnce(pool, "migration_race_test", async () => { executions += 1; }),
  ]);
  assert.equal(executions, 1);
});

test("owner repair and preexisting settings are explicit and deterministic", { skip: !connectionString }, async () => {
  assert.ok(pool && ensurePlatformSchema);
  const suffix = randomBytes(4).toString("hex");
  const orgId = `org_owner_${suffix}`;
  await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [orgId, "Owner", `owner-${suffix}`]);
  await pool.query("DROP INDEX IF EXISTS idx_users_one_owner_per_org; ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_normalized_check;");
  await pool.query(`
    INSERT INTO users(id,email,password_hash,name,org_id,role,created_at) VALUES
      ($1,$2,'x','First',$3,'OWNER','2020-01-01'),
      ($4,$5,'x','Second',$3,'owner','2021-01-01')
  `, [`u_owner_a_${suffix}`, `a-${suffix}@example.invalid`, orgId, `u_owner_b_${suffix}`, `b-${suffix}@example.invalid`]);
  await ensurePlatformSchema(pool);
  const roles = await pool.query("SELECT role FROM users WHERE org_id = $1 ORDER BY id", [orgId]);
  assert.deepEqual(roles.rows.map((row) => row.role), ["owner", "admin"]);

  const emptyOrg = `org_empty_${suffix}`;
  await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [emptyOrg, "Empty", `empty-${suffix}`]);
  await assert.rejects(ensurePlatformSchema(pool), /has no owner/);
  await pool.query("INSERT INTO users(id,email,password_hash,name,org_id,role) VALUES ($1,$2,'x','Owner',$3,'owner')", [`u_empty_${suffix}`, `empty-${suffix}@example.invalid`, emptyOrg]);

  const projectId = `project_settings_${suffix}`;
  await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,$2,$3,$4)", [projectId, "Settings", orgId, `${projectId}-key`]);
  await pool.query("DROP TABLE project_settings");
  await pool.query("DROP TABLE workspace_settings");
  await pool.query("DROP TABLE notification_preferences");
  await pool.query("CREATE TABLE project_settings(project_id TEXT PRIMARY KEY)");
  await pool.query("INSERT INTO project_settings(project_id) VALUES ($1)", [projectId]);
  await pool.query("CREATE TABLE workspace_settings(org_id TEXT PRIMARY KEY, timezone TEXT, reporting_currency TEXT)");
  await pool.query("INSERT INTO workspace_settings(org_id,timezone,reporting_currency) VALUES ($1,NULL,'bad')", [orgId]);
  await pool.query("CREATE TABLE notification_preferences(id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, project_id TEXT)");
  await pool.query("INSERT INTO notification_preferences(id,org_id,user_id) VALUES ($1,$2,$3)", [`pref_${suffix}`, orgId, `u_owner_a_${suffix}`]);
  await ensurePlatformSchema(pool);
  const settings = (await pool.query("SELECT capture_mode,body_capture_enabled,body_retention_days FROM project_settings WHERE project_id = $1", [projectId])).rows[0];
  assert.deepEqual(settings, { capture_mode: "text", body_capture_enabled: true, body_retention_days: 7 });
  assert.equal((await pool.query("SELECT reporting_currency,timezone FROM workspace_settings WHERE org_id = $1", [orgId])).rows[0]?.reporting_currency, "USD");
  assert.equal((await pool.query("SELECT weekly_summary_hour FROM notification_preferences WHERE id = $1", [`pref_${suffix}`])).rows[0]?.weekly_summary_hour, 9);
});
