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
      // Small Postgres tiers allow ~25 connections, and a rollout runs two
      // revisions at once: 10 each leaves room. COSTKEY_DB_POOL_SIZE raises it.
      max: Math.max(1, Number(process.env["COSTKEY_DB_POOL_SIZE"]) || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on("error", (err) => {
      console.error("[costkey] Postgres pool error:", err.message);
    });
    // Small Postgres tiers sort in 4 MB, so a month of runs spills to disk on
    // every query; 16 MB a sort keeps it in memory (COSTKEY_DB_WORK_MEM_MB).
    const workMemMb = Math.min(256, Math.max(4, Number(process.env["COSTKEY_DB_WORK_MEM_MB"]) || 16));
    pool.on("connect", (client) => {
      client.query(`SET work_mem = '${workMemMb}MB'`).catch(() => undefined);
    });
    logSlowQueries(pool);
  }
  return pool;
}

/** Queries slower than this are logged with their start, to find what holds the pool. */
const SLOW_QUERY_MS = Math.max(100, Number(process.env["COSTKEY_SLOW_QUERY_MS"]) || 1000);

/** Log each slow pool.query: how long it took, how busy the pool was, and the query's first words. */
function logSlowQueries(target: pg.Pool): void {
  const original = target.query.bind(target) as (...args: unknown[]) => unknown;
  (target as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const started = Date.now();
    const result = original(...args);
    if (!result || typeof (result as Promise<unknown>).finally !== "function") return result;
    const text = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: unknown } | undefined)?.text ?? "");
    return (result as Promise<unknown>).finally(() => {
      const ms = Date.now() - started;
      if (ms < SLOW_QUERY_MS) return;
      const sql = text.replace(/\s+/g, " ").trim();
      // Long queries share their opening CTEs; their end says which one this is.
      const shown = sql.length > 400 ? `${sql.slice(0, 120)} … ${sql.slice(-260)}` : sql;
      console.warn(`[costkey] Slow query ${ms}ms (pool ${target.totalCount - target.idleCount}/${target.totalCount} busy, ${target.waitingCount} waiting): ${shown}`);
    });
  };
}

export function getDb() {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

const MIGRATION_LOCK_KEY = "costkey:schema";

/**
 * Serialize structural migrations and one-shot backfills across app instances.
 * ponytail: one database-wide lock keeps startup safe; shard only if migration
 * throughput becomes a measured bottleneck.
 */
export async function withMigrationLock<T>(
  p: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await p.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [MIGRATION_LOCK_KEY]);
    return await fn(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/** Keep the accounting rollup shape current for callers that inject a pool. */
export async function ensureDailyAggregateSchema(
  client: pg.Pool | pg.PoolClient,
): Promise<void> {
  await client.query(`
    DO $daily_aggregate_compat$
    DECLARE
      old_pk TEXT;
    BEGIN
      IF to_regclass(format('%I.%I', current_schema(), 'daily_cost_aggregates')) IS NULL
         OR (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'daily_cost_aggregates'
               AND column_name IN ('project_id', 'day', 'environment', 'feature', 'function_key', 'customer', 'provider', 'model')) < 8 THEN
        RETURN;
      END IF;
      EXECUTE 'ALTER TABLE daily_cost_aggregates ADD COLUMN IF NOT EXISTS service TEXT';
      EXECUTE 'ALTER TABLE daily_cost_aggregates ADD COLUMN IF NOT EXISTS release TEXT';
      EXECUTE 'UPDATE daily_cost_aggregates SET service = COALESCE(service, ''(unassigned)''), release = COALESCE(release, ''(unassigned)'') WHERE service IS NULL OR release IS NULL';
      EXECUTE 'ALTER TABLE daily_cost_aggregates ALTER COLUMN service SET DEFAULT ''(unassigned)''';
      EXECUTE 'ALTER TABLE daily_cost_aggregates ALTER COLUMN release SET DEFAULT ''(unassigned)''';
      EXECUTE 'ALTER TABLE daily_cost_aggregates ALTER COLUMN service SET NOT NULL';
      EXECUTE 'ALTER TABLE daily_cost_aggregates ALTER COLUMN release SET NOT NULL';

      SELECT c.conname INTO old_pk
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE t.relname = 'daily_cost_aggregates'
         AND n.nspname = current_schema()
         AND c.contype = 'p'
         AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (project_id, day, environment, feature, function_key, customer, provider, model)'
       LIMIT 1;
      IF old_pk IS NOT NULL THEN
        EXECUTE format('ALTER TABLE daily_cost_aggregates DROP CONSTRAINT %I', old_pk);
      END IF;
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE t.relname = 'daily_cost_aggregates'
           AND n.nspname = current_schema()
           AND c.contype = 'p'
           AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (project_id, day, environment, feature, function_key, customer, service, release, provider, model)'
      ) THEN
        EXECUTE 'ALTER TABLE daily_cost_aggregates ADD CONSTRAINT daily_cost_aggregates_full_pkey PRIMARY KEY (project_id, day, environment, feature, function_key, customer, service, release, provider, model)';
      END IF;
    END $daily_aggregate_compat$;
  `);
}

/**
 * Record which quarter-hours of a project's calls and usage changed, whoever
 * changed them: ingest, repricing, call-site resolution, feature mappings,
 * cleanup. The daily rollup scheduler re-reconciles the days they fall in, and
 * summaries read a changed day from detail until it has been reconciled
 * (reconcileDailyAccounting in index.ts, rollupPlan in charge-cohort.ts).
 * Every timezone offset is a whole number of quarter-hours, so a period
 * never straddles a local day.
 */
export async function ensureAccountingChangeSchema(client: pg.Pool | pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS accounting_changed_periods (
      project_id TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, period_start)
    );

    CREATE OR REPLACE FUNCTION costkey_mark_changed_event_periods() RETURNS trigger
    LANGUAGE plpgsql AS $mark_events$
    BEGIN
      IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        INSERT INTO accounting_changed_periods (project_id, period_start)
        SELECT DISTINCT r.project_id, date_bin('15 minutes', r.timestamp, TIMESTAMPTZ '2000-01-01 00:00:00+00')
        FROM changed_new r WHERE r.timestamp IS NOT NULL
        ON CONFLICT (project_id, period_start) DO UPDATE SET changed_at = NOW();
      END IF;
      IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
        INSERT INTO accounting_changed_periods (project_id, period_start)
        SELECT DISTINCT r.project_id, date_bin('15 minutes', r.timestamp, TIMESTAMPTZ '2000-01-01 00:00:00+00')
        FROM changed_old r WHERE r.timestamp IS NOT NULL
        ON CONFLICT (project_id, period_start) DO UPDATE SET changed_at = NOW();
      END IF;
      RETURN NULL;
    END
    $mark_events$;

    CREATE OR REPLACE FUNCTION costkey_mark_changed_usage_periods() RETURNS trigger
    LANGUAGE plpgsql AS $mark_usage$
    BEGIN
      IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        INSERT INTO accounting_changed_periods (project_id, period_start)
        SELECT DISTINCT r.project_id, date_bin('15 minutes', COALESCE(r.accounting_at, r.observed_at), TIMESTAMPTZ '2000-01-01 00:00:00+00')
        FROM changed_new r WHERE COALESCE(r.accounting_at, r.observed_at) IS NOT NULL
        ON CONFLICT (project_id, period_start) DO UPDATE SET changed_at = NOW();
      END IF;
      IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
        INSERT INTO accounting_changed_periods (project_id, period_start)
        SELECT DISTINCT r.project_id, date_bin('15 minutes', COALESCE(r.accounting_at, r.observed_at), TIMESTAMPTZ '2000-01-01 00:00:00+00')
        FROM changed_old r WHERE COALESCE(r.accounting_at, r.observed_at) IS NOT NULL
        ON CONFLICT (project_id, period_start) DO UPDATE SET changed_at = NOW();
      END IF;
      RETURN NULL;
    END
    $mark_usage$;

    -- Created once: CREATE TRIGGER locks the table against writes, so a boot
    -- never re-creates a trigger that already exists.
    DO $change_triggers$
    DECLARE
      spec RECORD;
    BEGIN
      FOR spec IN
        SELECT * FROM (VALUES
          ('events', 'INSERT', 'costkey_mark_changed_event_periods', 'REFERENCING NEW TABLE AS changed_new'),
          ('events', 'UPDATE', 'costkey_mark_changed_event_periods', 'REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new'),
          ('events', 'DELETE', 'costkey_mark_changed_event_periods', 'REFERENCING OLD TABLE AS changed_old'),
          ('usage_components', 'INSERT', 'costkey_mark_changed_usage_periods', 'REFERENCING NEW TABLE AS changed_new'),
          ('usage_components', 'UPDATE', 'costkey_mark_changed_usage_periods', 'REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new'),
          ('usage_components', 'DELETE', 'costkey_mark_changed_usage_periods', 'REFERENCING OLD TABLE AS changed_old')
        ) AS t(table_name, operation, function_name, referencing)
      LOOP
        IF to_regclass(format('%I.%I', current_schema(), spec.table_name)) IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM pg_trigger tr
             JOIN pg_class c ON c.oid = tr.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = spec.table_name AND n.nspname = current_schema()
               AND tr.tgname = 'costkey_changed_periods_' || lower(spec.operation)
           ) THEN
          EXECUTE format(
            'CREATE TRIGGER %I AFTER %s ON %I %s FOR EACH STATEMENT EXECUTE FUNCTION %I()',
            'costkey_changed_periods_' || lower(spec.operation), spec.operation, spec.table_name,
            spec.referencing, spec.function_name
          );
        END IF;
      END LOOP;
    END $change_triggers$;
  `);
}

export async function initDatabase(): Promise<void> {
  const p = getPool();

  // Create tables using raw SQL for initial setup
  // Drizzle's push/migrate requires drizzle-kit CLI — for simplicity we create inline
  await withMigrationLock(p, (client) => client.query(`
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
      id TEXT NOT NULL,
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
      image_output_tokens INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events(project_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_project_model ON events(project_id, model);
    CREATE INDEX IF NOT EXISTS idx_events_trace ON events(project_id, trace_id);

    -- Event envelope ids are supplied by SDK callers and are only unique
    -- within a project. Migrate the original global primary key without
    -- rewriting ids or dropping any rows; this block is idempotent.
    DO $events_pk$
    DECLARE
      old_pk TEXT;
    BEGIN
      SELECT c.conname INTO old_pk
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = 'events'
        AND n.nspname = current_schema()
        AND c.contype = 'p'
        AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
      LIMIT 1;
      IF old_pk IS NOT NULL THEN
        EXECUTE format('ALTER TABLE events DROP CONSTRAINT %I', old_pk);
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'events'
          AND n.nspname = current_schema()
          AND c.contype = 'p'
          AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (project_id, id)'
      ) THEN
        ALTER TABLE events ADD CONSTRAINT events_project_id_id_pkey PRIMARY KEY (project_id, id);
      END IF;
    END $events_pk$;

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
    ALTER TABLE events ADD COLUMN IF NOT EXISTS image_output_tokens INTEGER;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'call';
    ALTER TABLE events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auto';
    ALTER TABLE events ADD COLUMN IF NOT EXISTS entity_type TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS entity_id TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS sequence INTEGER;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS request_model TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS attempt_id TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS parent_event_id TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS charge_id TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS component_id TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS execution_id TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS group_id TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS group_name TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS group_kind TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS phase TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS configuration JSONB;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS dataset_revision TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS case_id TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS lifecycle_state TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS lifecycle_at TIMESTAMPTZ;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS lifecycle_error_type TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS usage_event JSONB;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS cost_basis TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE events ADD COLUMN IF NOT EXISTS cost_source TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS pricing_id TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS pricing_date TIMESTAMPTZ;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS cost_currency TEXT NOT NULL DEFAULT 'USD';
    ALTER TABLE events ADD COLUMN IF NOT EXISTS unit_kind TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS unit_value DOUBLE PRECISION;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS unit TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS aggregation TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS revision INTEGER;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS content_status TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE events ADD COLUMN IF NOT EXISTS feature_source TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE events ADD COLUMN IF NOT EXISTS feature_mapping_id TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS feature_mapping_action_id TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS feature_original TEXT;
    CREATE INDEX IF NOT EXISTS idx_events_execution ON events(project_id, execution_id);
    CREATE INDEX IF NOT EXISTS idx_events_charge ON events(project_id, charge_id);
    -- Retries: attempts of one work item share context.work_id (retries.ts, WORK_ID_SQL).
    CREATE INDEX IF NOT EXISTS idx_events_work_id ON events (project_id, (NULLIF(COALESCE(context->>'work_id', context->>'workId', context->>'attempt_key'), '')))
      WHERE NULLIF(COALESCE(context->>'work_id', context->>'workId', context->>'attempt_key'), '') IS NOT NULL;
    ALTER TABLE call_site_stats ADD COLUMN IF NOT EXISTS priced_calls INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE call_site_stats ADD COLUMN IF NOT EXISTS unpriced_calls INTEGER NOT NULL DEFAULT 0;

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

    -- Migrate the pre-scoped budget schema before touching the firing table.
    -- The old firing table has project_id but no rule_id, so creating the new
    -- unique index first would abort an otherwise recoverable upgrade.
    DO $budget_rules_migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'project_budgets') THEN
        INSERT INTO budget_rules (
          id, project_id, name, scope_model, scope_function,
          daily_usd, monthly_usd, calls_per_minute, tokens_per_minute,
          on_exceed, alert_email, alert_webhook_url, alert_thresholds,
          enabled, created_at, updated_at
        )
        SELECT
          'rule_legacy_' || md5(project_id),
          project_id, 'Project-wide', NULL, NULL,
          daily_usd, monthly_usd, calls_per_minute, tokens_per_minute,
          on_exceed, alert_email, alert_webhook_url, alert_thresholds,
          enabled, created_at, updated_at
        FROM project_budgets
        ON CONFLICT (id) DO NOTHING;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'budget_alert_firings')
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'budget_alert_firings' AND column_name = 'project_id'
         ) THEN
        INSERT INTO budget_rules (id, project_id, name, scope_model, scope_function)
        SELECT DISTINCT 'rule_legacy_' || md5(project_id), project_id, 'Legacy project-wide', NULL, NULL
          FROM budget_alert_firings
         WHERE project_id IS NOT NULL
        ON CONFLICT (id) DO NOTHING;
      END IF;
    END $budget_rules_migration$;

    DO $budget_firings_migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'budget_alert_firings')
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'budget_alert_firings' AND column_name = 'rule_id'
         ) THEN
        CREATE TABLE budget_alert_firings_v2 (
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
        INSERT INTO budget_alert_firings_v2 (
          id, rule_id, project_id, scope, threshold, window_key,
          fired_at, spent_usd, limit_usd
        )
        SELECT id, 'rule_legacy_' || md5(project_id), project_id, scope, threshold,
               window_key, fired_at, spent_usd, limit_usd
          FROM budget_alert_firings;
        DROP TABLE budget_alert_firings;
        ALTER TABLE budget_alert_firings_v2 RENAME TO budget_alert_firings;
      END IF;
    END $budget_firings_migration$;

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

    DO $budget_cleanup$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'project_budgets') THEN
        DROP TABLE project_budgets;
      END IF;
    END $budget_cleanup$;
    CREATE TABLE IF NOT EXISTS alert_history (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id),
      triggered_at TIMESTAMPTZ DEFAULT NOW(),
      value DOUBLE PRECISION,
      message TEXT
    );

    -- Accounting foundation: lifecycle/group state is separate from billable
    -- provider events, and explicit component usage has independent revision
    -- and dedupe semantics.
    CREATE TABLE IF NOT EXISTS traces (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      trace_name TEXT,
      execution_id TEXT,
      group_id TEXT,
      state TEXT NOT NULL DEFAULT 'unknown',
      lifecycle_at TIMESTAMPTZ,
      lifecycle_sequence INTEGER,
      error_type TEXT,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      accounting_state TEXT NOT NULL DEFAULT 'pending',
      lifecycle_source TEXT NOT NULL DEFAULT 'observed',
      context JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_traces_project_started ON traces(project_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_traces_execution ON traces(project_id, execution_id);
    ALTER TABLE traces ADD COLUMN IF NOT EXISTS lifecycle_sequence INTEGER;

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other',
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, id),
      UNIQUE (project_id, name, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_groups_project ON groups(project_id);

    CREATE TABLE IF NOT EXISTS executions (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      group_id TEXT,
      name TEXT,
      kind TEXT NOT NULL DEFAULT 'other',
      state TEXT NOT NULL DEFAULT 'unknown',
      lifecycle_at TIMESTAMPTZ,
      lifecycle_sequence INTEGER,
      error_type TEXT,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      expected_items INTEGER,
      completed_items INTEGER,
      failed_items INTEGER,
      accounting_state TEXT NOT NULL DEFAULT 'pending',
      configuration JSONB,
      dataset_revision TEXT,
      context JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_executions_project_started ON executions(project_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_group ON executions(project_id, group_id);
    ALTER TABLE executions ADD COLUMN IF NOT EXISTS lifecycle_at TIMESTAMPTZ;
    ALTER TABLE executions ADD COLUMN IF NOT EXISTS lifecycle_sequence INTEGER;

    CREATE TABLE IF NOT EXISTS usage_components (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      charge_id TEXT,
      component_id TEXT,
      caller_id TEXT,
      context JSONB,
      trace_id TEXT,
      execution_id TEXT,
      group_id TEXT,
      phase TEXT,
      component TEXT NOT NULL DEFAULT 'custom',
      provider TEXT NOT NULL DEFAULT 'unknown',
      model TEXT,
      unit_kind TEXT,
      unit_value DOUBLE PRECISION,
      unit TEXT,
      amount DOUBLE PRECISION,
      currency TEXT NOT NULL DEFAULT 'USD',
      amount_kind TEXT NOT NULL DEFAULT 'reported',
      aggregation TEXT NOT NULL DEFAULT 'delta',
      revision INTEGER,
      pricing_id TEXT,
      payload_hash TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      accounting_at TIMESTAMPTZ,
      observed_at TIMESTAMPTZ NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_components_project_time ON usage_components(project_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_components_charge ON usage_components(project_id, charge_id);
    CREATE INDEX IF NOT EXISTS idx_usage_components_component ON usage_components(project_id, component_id);
    ALTER TABLE usage_components ADD COLUMN IF NOT EXISTS payload_hash TEXT;
    ALTER TABLE usage_components ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE usage_components ADD COLUMN IF NOT EXISTS pricing_id TEXT;
    ALTER TABLE usage_components ADD COLUMN IF NOT EXISTS caller_id TEXT;
    ALTER TABLE usage_components ADD COLUMN IF NOT EXISTS context JSONB;
    ALTER TABLE usage_components ADD COLUMN IF NOT EXISTS accounting_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_components_charge_revision
      ON usage_components(project_id, charge_id, revision)
      WHERE charge_id IS NOT NULL AND revision IS NOT NULL;

    -- Agent, step, tool and workflow spans. A span is upserted by id so its
    -- start and end deliveries both apply; provider calls link to the span
    -- they ran inside through events.span_id.
    CREATE TABLE IF NOT EXISTS spans (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      trace_id TEXT,
      parent_span_id TEXT,
      execution_id TEXT,
      kind TEXT NOT NULL DEFAULT 'custom',
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      error_type TEXT,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      attributes JSONB,
      context JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(project_id, trace_id);
    -- Walking a span's children (attributing calls to the span that holds them)
    -- scanned every span per step without this.
    CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(project_id, parent_span_id) WHERE parent_span_id IS NOT NULL;
    -- Every call query filters COALESCE(event_type, 'call') = 'call'; without
    -- statistics on that expression Postgres guesses 0.5% of rows match (it is
    -- nearly all of them) and plans the larger queries badly. Postgres 14+.
    DO $$ BEGIN
      CREATE STATISTICS IF NOT EXISTS events_call_kind ON (COALESCE(event_type, 'call')) FROM events;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
    -- Where the span was opened (filtered frames); calls with no code of their own take it.
    ALTER TABLE spans ADD COLUMN IF NOT EXISTS call_site_frames JSONB;
    CREATE INDEX IF NOT EXISTS idx_spans_project_started ON spans(project_id, started_at DESC);
    ALTER TABLE events ADD COLUMN IF NOT EXISTS span_id TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS sdk_version TEXT;
    -- Provider-native billing units reported with a call (for example Gemini
    -- grounding requests) that aren't tokens.
    ALTER TABLE events ADD COLUMN IF NOT EXISTS native_units JSONB;
    CREATE INDEX IF NOT EXISTS idx_events_span ON events(project_id, span_id) WHERE span_id IS NOT NULL;

    -- Judge, human and code scores on runs. Upserted by id so a re-graded
    -- run replaces its score; the comment is content and follows capture.
    CREATE TABLE IF NOT EXISTS scores (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      trace_id TEXT,
      span_id TEXT,
      name TEXT NOT NULL,
      value DOUBLE PRECISION NOT NULL,
      label TEXT,
      comment TEXT,
      source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      timestamp TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (project_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_scores_project_name_ts ON scores(project_id, name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_scores_trace ON scores(project_id, trace_id);

    CREATE TABLE IF NOT EXISTS credits (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      account_scope TEXT NOT NULL,
      cloud_project TEXT,
      currency TEXT NOT NULL,
      original_amount DOUBLE PRECISION NOT NULL,
      balance_amount DOUBLE PRECISION NOT NULL,
      balance_as_of TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ,
      eligibility JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'user_supplied',
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_credits_project_expiry ON credits(project_id, expires_at);

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      family TEXT NOT NULL,
      scope JSONB NOT NULL DEFAULT '{}'::jsonb,
      state TEXT NOT NULL DEFAULT 'new',
      observed_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      baseline JSONB,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      next_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      acknowledged_at TIMESTAMPTZ,
      acknowledged_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (project_id, family, scope)
    );
    CREATE INDEX IF NOT EXISTS idx_findings_project_state ON findings(project_id, state, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS finding_thresholds (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      expensive_sample INTEGER NOT NULL DEFAULT 20,
      expensive_multiplier DOUBLE PRECISION NOT NULL DEFAULT 3,
      expensive_min_absolute DOUBLE PRECISION NOT NULL DEFAULT 0.05,
      unit_sample INTEGER NOT NULL DEFAULT 20,
      unit_min_relative DOUBLE PRECISION NOT NULL DEFAULT 0.5,
      unit_min_impact DOUBLE PRECISION NOT NULL DEFAULT 1,
      coverage_min_drop DOUBLE PRECISION NOT NULL DEFAULT 0.1,
      allowance_min_ratio DOUBLE PRECISION NOT NULL DEFAULT 0.8,
      updated_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE finding_thresholds ADD COLUMN IF NOT EXISTS expensive_sample INTEGER;
    ALTER TABLE finding_thresholds ADD COLUMN IF NOT EXISTS expensive_multiplier DOUBLE PRECISION;
    ALTER TABLE finding_thresholds ADD COLUMN IF NOT EXISTS expensive_min_absolute DOUBLE PRECISION;
    ALTER TABLE finding_thresholds ADD COLUMN IF NOT EXISTS unit_sample INTEGER;
    ALTER TABLE finding_thresholds ADD COLUMN IF NOT EXISTS unit_min_relative DOUBLE PRECISION;
    ALTER TABLE finding_thresholds ADD COLUMN IF NOT EXISTS unit_min_impact DOUBLE PRECISION;
    ALTER TABLE finding_thresholds ADD COLUMN IF NOT EXISTS coverage_min_drop DOUBLE PRECISION;
    ALTER TABLE finding_thresholds ADD COLUMN IF NOT EXISTS allowance_min_ratio DOUBLE PRECISION;
    ALTER TABLE finding_thresholds ADD COLUMN IF NOT EXISTS updated_by TEXT;
    ALTER TABLE finding_thresholds ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE finding_thresholds ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE finding_thresholds ALTER COLUMN expensive_sample SET DEFAULT 20;
    ALTER TABLE finding_thresholds ALTER COLUMN expensive_multiplier SET DEFAULT 3;
    ALTER TABLE finding_thresholds ALTER COLUMN expensive_min_absolute SET DEFAULT 0.05;
    ALTER TABLE finding_thresholds ALTER COLUMN unit_sample SET DEFAULT 20;
    ALTER TABLE finding_thresholds ALTER COLUMN unit_min_relative SET DEFAULT 0.5;
    ALTER TABLE finding_thresholds ALTER COLUMN unit_min_impact SET DEFAULT 1;
    ALTER TABLE finding_thresholds ALTER COLUMN coverage_min_drop SET DEFAULT 0.1;
    ALTER TABLE finding_thresholds ALTER COLUMN allowance_min_ratio SET DEFAULT 0.8;
    UPDATE finding_thresholds SET
      expensive_sample = COALESCE(expensive_sample, 20), expensive_multiplier = COALESCE(expensive_multiplier, 3),
      expensive_min_absolute = COALESCE(expensive_min_absolute, 0.05), unit_sample = COALESCE(unit_sample, 20),
      unit_min_relative = COALESCE(unit_min_relative, 0.5), unit_min_impact = COALESCE(unit_min_impact, 1),
      coverage_min_drop = COALESCE(coverage_min_drop, 0.1), allowance_min_ratio = COALESCE(allowance_min_ratio, 0.8),
      updated_at = COALESCE(updated_at, NOW());
    INSERT INTO finding_thresholds(project_id)
      SELECT id FROM projects ON CONFLICT (project_id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS forecast_scenarios (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      scope JSONB NOT NULL DEFAULT '{}'::jsonb,
      assumptions JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB,
      shared BOOLEAN NOT NULL DEFAULT FALSE,
      calculated_at TIMESTAMPTZ,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_forecast_scenarios_project ON forecast_scenarios(project_id, updated_at DESC);

    -- Daily rollups are the durable accounting source for periods whose detail
    -- has expired. Keep every supported explorer lens explicit so a retention
    -- job can archive detail without erasing historical attribution.
    CREATE TABLE IF NOT EXISTS daily_cost_aggregates (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      environment TEXT NOT NULL DEFAULT '(unassigned)',
      feature TEXT NOT NULL DEFAULT '(unassigned)',
      function_key TEXT NOT NULL DEFAULT '(unassigned)',
      customer TEXT NOT NULL DEFAULT '(unassigned)',
      service TEXT NOT NULL DEFAULT '(unassigned)',
      release TEXT NOT NULL DEFAULT '(unassigned)',
      provider TEXT NOT NULL DEFAULT '(unknown)',
      model TEXT NOT NULL DEFAULT '(unknown)',
      known_cost_usd DOUBLE PRECISION,
      observations INTEGER NOT NULL DEFAULT 0,
      call_count INTEGER NOT NULL DEFAULT 0,
      priced_observations INTEGER NOT NULL DEFAULT 0,
      unpriced_observations INTEGER NOT NULL DEFAULT 0,
      trace_count INTEGER NOT NULL DEFAULT 0,
      fully_priced_trace_count INTEGER NOT NULL DEFAULT 0,
      fully_priced_trace_cost_usd DOUBLE PRECISION,
      reported_observations INTEGER NOT NULL DEFAULT 0,
      estimated_observations INTEGER NOT NULL DEFAULT 0,
      unknown_observations INTEGER NOT NULL DEFAULT 0,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, day, environment, feature, function_key, customer, service, release, provider, model)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_cost_aggregates_project_day ON daily_cost_aggregates(project_id, day);
    ALTER TABLE daily_cost_aggregates ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
    ALTER TABLE daily_cost_aggregates ADD COLUMN IF NOT EXISTS call_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE daily_cost_aggregates ADD COLUMN IF NOT EXISTS service TEXT NOT NULL DEFAULT '(unassigned)';
    ALTER TABLE daily_cost_aggregates ADD COLUMN IF NOT EXISTS release TEXT NOT NULL DEFAULT '(unassigned)';
    ALTER TABLE daily_cost_aggregates ADD COLUMN IF NOT EXISTS trace_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE daily_cost_aggregates ADD COLUMN IF NOT EXISTS fully_priced_trace_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE daily_cost_aggregates ADD COLUMN IF NOT EXISTS fully_priced_trace_cost_usd DOUBLE PRECISION;
    ALTER TABLE daily_cost_aggregates ADD COLUMN IF NOT EXISTS reported_observations INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE daily_cost_aggregates ADD COLUMN IF NOT EXISTS estimated_observations INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE daily_cost_aggregates ADD COLUMN IF NOT EXISTS unknown_observations INTEGER NOT NULL DEFAULT 0;
    DO $daily_aggregate_pk$
    DECLARE
      old_pk TEXT;
    BEGIN
      SELECT c.conname INTO old_pk
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = 'daily_cost_aggregates' AND n.nspname = current_schema()
        AND c.contype = 'p'
        AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (project_id, day, environment, feature, function_key, customer, provider, model)'
      LIMIT 1;
      IF old_pk IS NOT NULL THEN EXECUTE format('ALTER TABLE daily_cost_aggregates DROP CONSTRAINT %I', old_pk); END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'daily_cost_aggregates' AND n.nspname = current_schema()
          AND c.contype = 'p'
          AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (project_id, day, environment, feature, function_key, customer, service, release, provider, model)'
      ) THEN
        ALTER TABLE daily_cost_aggregates ADD CONSTRAINT daily_cost_aggregates_full_pkey PRIMARY KEY (project_id, day, environment, feature, function_key, customer, service, release, provider, model);
      END IF;
    END $daily_aggregate_pk$;
    CREATE TABLE IF NOT EXISTS daily_cost_aggregate_checkpoints (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      through_day DATE NOT NULL,
      source_created_before TIMESTAMPTZ NOT NULL,
      generation BIGINT NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS price_overrides (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '1m_tokens',
      input_rate DOUBLE PRECISION,
      output_rate DOUBLE PRECISION,
      currency TEXT NOT NULL DEFAULT 'USD',
      effective_from TIMESTAMPTZ NOT NULL,
      effective_to TIMESTAMPTZ,
      source TEXT NOT NULL DEFAULT 'user_supplied',
      updated_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_price_overrides_org_model_date ON price_overrides(org_id, provider, model, effective_from);
    CREATE INDEX IF NOT EXISTS idx_price_overrides_project_model_date ON price_overrides(project_id, provider, model, effective_from);

    CREATE TABLE IF NOT EXISTS effective_prices (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      account_scope TEXT NOT NULL,
      model TEXT,
      native_unit TEXT NOT NULL,
      price_per_unit DOUBLE PRECISION NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      effective_from TIMESTAMPTZ NOT NULL,
      effective_to TIMESTAMPTZ,
      source TEXT NOT NULL DEFAULT 'user_supplied',
      version INTEGER NOT NULL,
      pricing_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      revoked_at TIMESTAMPTZ,
      created_by TEXT,
      updated_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_effective_prices_project_scope
      ON effective_prices(project_id, provider, account_scope, native_unit, effective_from);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_effective_prices_version
      ON effective_prices(project_id, provider, account_scope, model, native_unit, currency, version);

    CREATE TABLE IF NOT EXISTS feature_mappings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      feature TEXT NOT NULL,
      match JSONB NOT NULL DEFAULT '{}'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_feature_mappings_project ON feature_mappings(project_id, enabled);

    CREATE TABLE IF NOT EXISTS feature_mapping_actions (
      id TEXT PRIMARY KEY,
      mapping_id TEXT NOT NULL REFERENCES feature_mappings(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      from_time TIMESTAMPTZ,
      to_time TIMESTAMPTZ,
      matched_count INTEGER NOT NULL DEFAULT 0,
      override_explicit BOOLEAN NOT NULL DEFAULT FALSE,
      performed_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_feature_mapping_actions_project ON feature_mapping_actions(project_id, created_at DESC);

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
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    UPDATE migrations SET ran_at = COALESCE(ran_at, NOW());
    ALTER TABLE migrations ALTER COLUMN ran_at SET DEFAULT NOW();
    ALTER TABLE migrations ALTER COLUMN ran_at SET NOT NULL;
  `));

  // ── Raw SDK telemetry (SDK 0.7+) ──
  // The raw call envelope a provider call arrived with, kept for reprocessing
  // when extractors improve. It follows metadata's privacy treatment: stored
  // only for projects with body capture, redacted, cleared with captured
  // content and by body retention.
  await withMigrationLock(p, (client) => client.query(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS raw_telemetry JSONB;
  `));

  // Ingest sets content_status and feature_source on every new event, so only
  // rows stored before those columns existed need them. Run this once: as a
  // startup statement it rewrote every 'unknown' row on each boot while the
  // schema transaction held an exclusive lock on events.
  await runOnce(p, "backfill_event_content_and_feature_source_v1", async () => {
    await p.query(`
      UPDATE events SET content_status = 'captured'
      WHERE content_status = 'unknown'
        AND (request_body IS NOT NULL OR response_body IS NOT NULL OR system_prompt IS NOT NULL
          OR metadata ? 'prompt' OR metadata ? 'prompts' OR metadata ? 'completion' OR metadata ? 'response')
    `);
    await p.query(`
      UPDATE events SET feature_source = 'explicit'
      WHERE feature_source = 'unknown'
        AND context ? 'feature' AND NULLIF(BTRIM(context->>'feature'), '') IS NOT NULL
    `);
  });

  // Ingest and repricing keep priced_calls and unpriced_calls current; only call
  // sites stored before those columns existed need a recount from events.
  await runOnce(p, "backfill_call_site_priced_counts_v1", async () => {
    await p.query(`
      UPDATE call_site_stats cs SET
        priced_calls = totals.priced_calls,
        unpriced_calls = totals.unpriced_calls
      FROM (
        SELECT project_id,
               CONCAT(COALESCE(bl_file, 'unknown'), ':', COALESCE(bl_function, 'anonymous'), ':', COALESCE(bl_line::text, '0')) AS call_site_key,
               COALESCE(model, 'unknown') AS model,
               COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::int AS priced_calls,
               COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced_calls
        FROM events
        WHERE COALESCE(event_type, 'call') = 'call' AND bl_function IS NOT NULL
        GROUP BY project_id, call_site_key, model
      ) totals
      WHERE cs.project_id = totals.project_id
        AND cs.call_site_key = totals.call_site_key
        AND COALESCE(cs.model, 'unknown') = totals.model
    `);
  });

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
  await withMigrationLock(p, async (client) => {
    const check = await client.query(
      "SELECT 1 FROM migrations WHERE name = $1",
      [name],
    );
    if (check.rows.length > 0) {
      console.log(`[costkey] Migration "${name}" already ran, skipping`);
      return;
    }
    console.log(`[costkey] Running migration "${name}"...`);
    await fn();
    await client.query("BEGIN");
    try {
      await client.query("INSERT INTO migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [name]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    console.log(`[costkey] Migration "${name}" complete`);
  });
}

export async function shutdownDatabase(): Promise<void> {
  if (pool) await pool.end();
}

// ── Quality checks (server-side evaluation) ───────────────────────────────
// Per-project check configuration and a durable job queue. The worker in
// quality-checks/worker.ts writes one score per check per run into `scores`.
// Every statement is idempotent; callers may run this on every startup.
export async function ensureQualityCheckSchema(p: pg.Pool | pg.PoolClient): Promise<void> {
  await p.query(`
    CREATE TABLE IF NOT EXISTS quality_checks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      template TEXT,
      rule TEXT,
      target DOUBLE PRECISION,
      rubric TEXT,
      judge_provider TEXT,
      judge_model TEXT,
      judge_key_encrypted TEXT,
      judge_key_hint TEXT,
      applies_to TEXT NOT NULL DEFAULT 'all',
      applies_to_names TEXT[] NOT NULL DEFAULT '{}',
      sample_rate DOUBLE PRECISION NOT NULL DEFAULT 100,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT,
      updated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quality_checks_project_name ON quality_checks(project_id, name);

    CREATE TABLE IF NOT EXISTS quality_check_jobs (
      id BIGSERIAL PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      check_id TEXT NOT NULL REFERENCES quality_checks(id) ON DELETE CASCADE,
      trace_id TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'auto',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ,
      skip_reason TEXT,
      last_error TEXT,
      score_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quality_check_jobs_check_trace ON quality_check_jobs(check_id, trace_id);
    CREATE INDEX IF NOT EXISTS idx_quality_check_jobs_due ON quality_check_jobs(next_run_at) WHERE status IN ('pending', 'running');
    CREATE INDEX IF NOT EXISTS idx_quality_check_jobs_trace ON quality_check_jobs(project_id, trace_id);

    -- How far the worker has scanned each project's traces for finished runs.
    CREATE TABLE IF NOT EXISTS quality_check_cursors (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      scanned_at TIMESTAMPTZ NOT NULL,
      scanned_trace_id TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_traces_project_updated ON traces(project_id, updated_at);
  `);
}
