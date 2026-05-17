import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://costkey:costkey@localhost:5432/costkey";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on("error", (err) => {
      console.error("[costkey] Postgres pool error:", err.message);
    });
  }
  return pool;
}

export function getDb() {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

export async function initDatabase(): Promise<void> {
  const p = getPool();

  // Create tables using raw SQL for initial setup
  // Drizzle's push/migrate requires drizzle-kit CLI — for simplicity we create inline
  await p.query(`
    CREATE TABLE IF NOT EXISTS orgs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES orgs(id),
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES orgs(id),
      auth_key TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      url TEXT,
      method TEXT,
      status_code INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      cost_usd DOUBLE PRECISION,
      duration_ms DOUBLE PRECISION,
      streaming BOOLEAN DEFAULT FALSE,
      ttft DOUBLE PRECISION,
      tps DOUBLE PRECISION,
      stream_duration DOUBLE PRECISION,
      chunk_count INTEGER,
      call_site_raw TEXT,
      call_site_frames JSONB,
      trace_id TEXT,
      trace_name TEXT,
      context JSONB,
      request_body JSONB,
      response_body JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events(project_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_project_model ON events(project_id, model);
    CREATE INDEX IF NOT EXISTS idx_events_trace ON events(project_id, trace_id);

    CREATE TABLE IF NOT EXISTS call_site_stats (
      project_id TEXT NOT NULL,
      call_site_key TEXT NOT NULL,
      file_name TEXT,
      function_name TEXT,
      line_number INTEGER,
      provider TEXT,
      model TEXT,
      total_calls INTEGER DEFAULT 0,
      total_cost_usd DOUBLE PRECISION DEFAULT 0,
      total_input_tokens BIGINT DEFAULT 0,
      total_output_tokens BIGINT DEFAULT 0,
      avg_duration_ms DOUBLE PRECISION DEFAULT 0,
      avg_ttft DOUBLE PRECISION,
      avg_tps DOUBLE PRECISION,
      first_seen TIMESTAMPTZ,
      last_seen TIMESTAMPTZ,
      PRIMARY KEY (project_id, call_site_key, model)
    );
    CREATE INDEX IF NOT EXISTS idx_callsite_cost ON call_site_stats(project_id, total_cost_usd DESC);

    ALTER TABLE events ADD COLUMN IF NOT EXISTS release TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS bl_function TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS bl_file TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS bl_line INTEGER;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS system_prompt TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS metadata JSONB;

    -- GitHub OAuth: add github_id, make password_hash nullable
    ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id TEXT;
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github ON users(github_id) WHERE github_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS sourcemaps (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      release TEXT NOT NULL,
      file_name TEXT NOT NULL,
      sourcemap_json TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (project_id, release, file_name)
    );
    CREATE INDEX IF NOT EXISTS idx_sourcemaps_lookup ON sourcemaps(project_id, release);

    CREATE TABLE IF NOT EXISTS team_invites (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id),
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      invited_by TEXT NOT NULL REFERENCES users(id),
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      accepted_by TEXT REFERENCES users(id),
      revoked_at TIMESTAMPTZ,
      revoked_by TEXT REFERENCES users(id),
      resent_count INTEGER NOT NULL DEFAULT 0,
      last_resent_at TIMESTAMPTZ
    );
    -- Enterprise audit columns (migration-safe for existing deployments)
    ALTER TABLE team_invites ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
    ALTER TABLE team_invites ADD COLUMN IF NOT EXISTS accepted_by TEXT REFERENCES users(id);
    ALTER TABLE team_invites ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
    ALTER TABLE team_invites ADD COLUMN IF NOT EXISTS revoked_by TEXT REFERENCES users(id);
    ALTER TABLE team_invites ADD COLUMN IF NOT EXISTS resent_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE team_invites ADD COLUMN IF NOT EXISTS last_resent_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_team_invites_org_status ON team_invites(org_id, status);
    CREATE INDEX IF NOT EXISTS idx_team_invites_email_status ON team_invites(LOWER(email), status);
    CREATE TABLE IF NOT EXISTS alerts (
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

    -- Budget rules: N per project, each with an optional scope (NULL = match
    -- all) and caps. A call must satisfy every matching rule.
    CREATE TABLE IF NOT EXISTS budget_rules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT,
      scope_model TEXT,
      scope_function TEXT,
      daily_usd DOUBLE PRECISION,
      monthly_usd DOUBLE PRECISION,
      calls_per_minute INTEGER,
      tokens_per_minute INTEGER,
      on_exceed TEXT NOT NULL DEFAULT 'warn',
      alert_email TEXT,
      alert_webhook_url TEXT,
      alert_thresholds DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[0.5, 0.8, 1.0],
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_budget_rules_project ON budget_rules(project_id);

    -- Dedupe per (rule, scope, threshold, window) so a per-model rule's 80%
    -- alert is independent from the project-wide rule's 80% alert.
    CREATE TABLE IF NOT EXISTS budget_alert_firings (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES budget_rules(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      threshold DOUBLE PRECISION NOT NULL,
      window_key TEXT NOT NULL,
      fired_at TIMESTAMPTZ DEFAULT NOW(),
      spent_usd DOUBLE PRECISION NOT NULL,
      limit_usd DOUBLE PRECISION NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_alert_fired_once
      ON budget_alert_firings(rule_id, scope, threshold, window_key);

    -- Migration: prior version had project_budgets (1:1 with projects) and
    -- budget_alert_firings keyed by project_id. Move any existing rows to
    -- budget_rules (as scope-less project-wide rules), then drop.
    DO $mig$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='project_budgets') THEN
        INSERT INTO budget_rules (
          id, project_id, name, scope_model, scope_function,
          daily_usd, monthly_usd, calls_per_minute, tokens_per_minute,
          on_exceed, alert_email, alert_webhook_url, alert_thresholds,
          enabled, created_at, updated_at
        )
        SELECT
          'rule_' || substr(md5(random()::text || project_id), 1, 24),
          project_id, 'Project-wide', NULL, NULL,
          daily_usd, monthly_usd, calls_per_minute, tokens_per_minute,
          on_exceed, alert_email, alert_webhook_url, alert_thresholds,
          enabled, created_at, updated_at
        FROM project_budgets
        ON CONFLICT DO NOTHING;
        DROP TABLE project_budgets CASCADE;
      END IF;
    END $mig$;
    CREATE TABLE IF NOT EXISTS alert_history (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id),
      triggered_at TIMESTAMPTZ DEFAULT NOW(),
      value DOUBLE PRECISION,
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS call_graphs (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      graph_data JSONB NOT NULL,
      sdk_version TEXT,
      PRIMARY KEY (project_id)
    );

    CREATE TABLE IF NOT EXISTS custom_providers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      hostname TEXT NOT NULL,
      usage_input_path TEXT DEFAULT 'usage.prompt_tokens',
      usage_output_path TEXT DEFAULT 'usage.completion_tokens',
      model_path TEXT DEFAULT 'model',
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_custom_providers_project ON custom_providers(project_id);

    CREATE TABLE IF NOT EXISTS frame_stats (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      function_name TEXT NOT NULL,
      total_seen INTEGER NOT NULL DEFAULT 0,
      position_sum INTEGER NOT NULL DEFAULT 0,
      stack_depth_sum INTEGER NOT NULL DEFAULT 0,
      distinct_call_sites INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, file_name, function_name)
    );
    CREATE INDEX IF NOT EXISTS idx_frame_stats_project ON frame_stats(project_id);

    CREATE TABLE IF NOT EXISTS frame_stats_callsites (
      project_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      function_name TEXT NOT NULL,
      call_site_key TEXT NOT NULL,
      PRIMARY KEY (project_id, file_name, function_name, call_site_key)
    );

    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("[costkey] Database schema initialized");
}

/**
 * Run a one-time operation (backfill, ALTER TABLE, etc.) exactly once.
 * Uses the migrations table to track what has already run.
 */
export async function runOnce(
  p: pg.Pool,
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const check = await p.query(
    "SELECT 1 FROM migrations WHERE name = $1",
    [name],
  );
  if (check.rows.length > 0) {
    console.log(`[costkey] Migration "${name}" already ran, skipping`);
    return;
  }
  console.log(`[costkey] Running migration "${name}"...`);
  await fn();
  await p.query("INSERT INTO migrations (name) VALUES ($1)", [name]);
  console.log(`[costkey] Migration "${name}" complete`);
}

export async function shutdownDatabase(): Promise<void> {
  if (pool) await pool.end();
}
