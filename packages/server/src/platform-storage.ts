import type pg from "pg";
import { ensureDailyAggregateSchema, withMigrationLock } from "./db.js";
import { ensureFramesSchema } from "./frames.js";

/**
 * Additive storage owned by the platform routes.
 *
 * The first CostKey schema predates project assignments, privacy settings and
 * delivery state.  Keep these tables outside the Drizzle schema until the
 * accounting migration owns them; every statement is idempotent so a deploy
 * can be upgraded without rewriting existing events or capture settings.
 */
export async function ensurePlatformSchema(pool: pg.Pool): Promise<void> {
  await withMigrationLock(pool, async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    UPDATE migrations SET ran_at = COALESCE(ran_at, NOW());
    ALTER TABLE migrations ALTER COLUMN ran_at SET DEFAULT NOW();
    ALTER TABLE migrations ALTER COLUMN ran_at SET NOT NULL;
    CREATE TABLE IF NOT EXISTS project_memberships (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_memberships_user
      ON project_memberships(user_id, project_id);
    -- Normalize legacy role casing before enforcing ownership. Duplicate
    -- owners are repaired deterministically; a zero-owner workspace fails
    -- closed so startup never silently grants ownership to an arbitrary user.
    DO $owner_repair$
    DECLARE
      workspace RECORD;
      retained_owner TEXT;
    BEGIN
      FOR workspace IN SELECT id FROM orgs ORDER BY id LOOP
        SELECT id INTO retained_owner
          FROM users
         WHERE org_id = workspace.id AND lower(btrim(role)) = 'owner'
         ORDER BY created_at NULLS LAST, id
         LIMIT 1;
        IF retained_owner IS NULL THEN
          RAISE EXCEPTION 'workspace % has no owner; repair ownership before starting CostKey', workspace.id
            USING ERRCODE = 'check_violation';
        END IF;
        UPDATE users
           SET role = 'admin'
         WHERE org_id = workspace.id
           AND lower(btrim(role)) = 'owner'
           AND id <> retained_owner;
        UPDATE users SET role = 'owner' WHERE id = retained_owner;
      END LOOP;
      UPDATE users
         SET role = lower(btrim(role))
       WHERE role IS NOT NULL
         AND role IS DISTINCT FROM lower(btrim(role));
    END $owner_repair$;
    DO $owner_constraint$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'users'))
           AND conname = 'users_role_normalized_check'
      ) THEN
        ALTER TABLE users ADD CONSTRAINT users_role_normalized_check
          CHECK (role = lower(btrim(role))) NOT VALID;
      END IF;
    END $owner_constraint$;
    ALTER TABLE users VALIDATE CONSTRAINT users_role_normalized_check;
    -- App-level transfers lock this workspace before changing roles; this
    -- partial unique index also prevents a second committed owner.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_one_owner_per_org
      ON users(org_id) WHERE lower(btrim(role)) = 'owner';

    CREATE TABLE IF NOT EXISTS workspace_settings (
      org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      reporting_currency TEXT NOT NULL DEFAULT 'USD',
      fx_rate DOUBLE PRECISION,
      fx_source TEXT,
      fx_as_of TIMESTAMPTZ,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT workspace_settings_currency_check CHECK (reporting_currency IN ('USD', 'INR'))
    );
    ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS timezone TEXT;
    ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS reporting_currency TEXT;
    ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS fx_rate DOUBLE PRECISION;
    ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS fx_source TEXT;
    ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS fx_as_of TIMESTAMPTZ;
    ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS updated_by TEXT;
    ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
    ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
    UPDATE workspace_settings
       SET timezone = CASE WHEN timezone IS NULL OR btrim(timezone) = '' THEN 'UTC' ELSE timezone END,
           reporting_currency = CASE WHEN reporting_currency IN ('USD', 'INR') THEN reporting_currency ELSE 'USD' END,
           created_at = COALESCE(created_at, NOW()),
           updated_at = COALESCE(updated_at, NOW());
    ALTER TABLE workspace_settings ALTER COLUMN timezone SET DEFAULT 'UTC';
    ALTER TABLE workspace_settings ALTER COLUMN reporting_currency SET DEFAULT 'USD';
    ALTER TABLE workspace_settings ALTER COLUMN timezone SET NOT NULL;
    ALTER TABLE workspace_settings ALTER COLUMN reporting_currency SET NOT NULL;
    ALTER TABLE workspace_settings ALTER COLUMN created_at SET DEFAULT NOW();
    ALTER TABLE workspace_settings ALTER COLUMN updated_at SET DEFAULT NOW();
    ALTER TABLE workspace_settings ALTER COLUMN created_at SET NOT NULL;
    ALTER TABLE workspace_settings ALTER COLUMN updated_at SET NOT NULL;
    DO $workspace_settings_check$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'workspace_settings'))
           AND conname = 'workspace_settings_currency_check'
      ) THEN
        ALTER TABLE workspace_settings ADD CONSTRAINT workspace_settings_currency_check
          CHECK (reporting_currency IN ('USD', 'INR')) NOT VALID;
      END IF;
    END $workspace_settings_check$;
    ALTER TABLE workspace_settings VALIDATE CONSTRAINT workspace_settings_currency_check;
    CREATE INDEX IF NOT EXISTS idx_workspace_settings_updated ON workspace_settings(updated_at);

    CREATE TABLE IF NOT EXISTS project_settings (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      capture_mode TEXT NOT NULL DEFAULT 'text',
      body_capture_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      redaction_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      body_retention_days INTEGER NOT NULL DEFAULT 7,
      metadata_retention_days INTEGER NOT NULL DEFAULT 30,
      aggregate_retention_days INTEGER NOT NULL DEFAULT 395,
      source_access_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT project_settings_capture_mode_check
        CHECK (capture_mode IN ('metadata', 'text')),
      CONSTRAINT project_settings_body_retention_check
        CHECK (body_retention_days > 0),
      CONSTRAINT project_settings_metadata_retention_check
        CHECK (metadata_retention_days > 0),
      CONSTRAINT project_settings_aggregate_retention_check
        CHECK (aggregate_retention_days > 0)
    );

    ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS capture_mode TEXT;
    ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS body_capture_enabled BOOLEAN;
    ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS redaction_enabled BOOLEAN;
    ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS body_retention_days INTEGER;
    ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS metadata_retention_days INTEGER;
    ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS aggregate_retention_days INTEGER;
    ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS source_access_enabled BOOLEAN;
    ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS updated_by TEXT;
    ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
    ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
    UPDATE project_settings
       SET capture_mode = CASE WHEN capture_mode IN ('metadata', 'text') THEN capture_mode ELSE 'text' END,
           body_capture_enabled = COALESCE(body_capture_enabled, TRUE),
           redaction_enabled = COALESCE(redaction_enabled, TRUE),
           body_retention_days = CASE WHEN body_retention_days > 0 THEN body_retention_days ELSE 7 END,
           metadata_retention_days = CASE WHEN metadata_retention_days > 0 THEN metadata_retention_days ELSE 30 END,
           aggregate_retention_days = CASE WHEN aggregate_retention_days > 0 THEN aggregate_retention_days ELSE 395 END,
           source_access_enabled = COALESCE(source_access_enabled, TRUE),
           created_at = COALESCE(created_at, NOW()),
           updated_at = COALESCE(updated_at, NOW());
    ALTER TABLE project_settings ALTER COLUMN capture_mode SET DEFAULT 'text';
    ALTER TABLE project_settings ALTER COLUMN body_capture_enabled SET DEFAULT TRUE;
    ALTER TABLE project_settings ALTER COLUMN redaction_enabled SET DEFAULT TRUE;
    ALTER TABLE project_settings ALTER COLUMN body_retention_days SET DEFAULT 7;
    ALTER TABLE project_settings ALTER COLUMN metadata_retention_days SET DEFAULT 30;
    ALTER TABLE project_settings ALTER COLUMN aggregate_retention_days SET DEFAULT 395;
    ALTER TABLE project_settings ALTER COLUMN source_access_enabled SET DEFAULT TRUE;
    ALTER TABLE project_settings ALTER COLUMN capture_mode SET NOT NULL;
    ALTER TABLE project_settings ALTER COLUMN body_capture_enabled SET NOT NULL;
    ALTER TABLE project_settings ALTER COLUMN redaction_enabled SET NOT NULL;
    ALTER TABLE project_settings ALTER COLUMN body_retention_days SET NOT NULL;
    ALTER TABLE project_settings ALTER COLUMN metadata_retention_days SET NOT NULL;
    ALTER TABLE project_settings ALTER COLUMN aggregate_retention_days SET NOT NULL;
    ALTER TABLE project_settings ALTER COLUMN source_access_enabled SET NOT NULL;
    ALTER TABLE project_settings ALTER COLUMN created_at SET DEFAULT NOW();
    ALTER TABLE project_settings ALTER COLUMN updated_at SET DEFAULT NOW();
    ALTER TABLE project_settings ALTER COLUMN created_at SET NOT NULL;
    ALTER TABLE project_settings ALTER COLUMN updated_at SET NOT NULL;
    DO $project_settings_checks$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'project_settings')) AND conname = 'project_settings_capture_mode_check') THEN
        ALTER TABLE project_settings ADD CONSTRAINT project_settings_capture_mode_check CHECK (capture_mode IN ('metadata', 'text')) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'project_settings')) AND conname = 'project_settings_body_retention_check') THEN
        ALTER TABLE project_settings ADD CONSTRAINT project_settings_body_retention_check CHECK (body_retention_days > 0) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'project_settings')) AND conname = 'project_settings_metadata_retention_check') THEN
        ALTER TABLE project_settings ADD CONSTRAINT project_settings_metadata_retention_check CHECK (metadata_retention_days > 0) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'project_settings')) AND conname = 'project_settings_aggregate_retention_check') THEN
        ALTER TABLE project_settings ADD CONSTRAINT project_settings_aggregate_retention_check CHECK (aggregate_retention_days > 0) NOT VALID;
      END IF;
    END $project_settings_checks$;
    ALTER TABLE project_settings VALIDATE CONSTRAINT project_settings_capture_mode_check;
    ALTER TABLE project_settings VALIDATE CONSTRAINT project_settings_body_retention_check;
    ALTER TABLE project_settings VALIDATE CONSTRAINT project_settings_metadata_retention_check;
    ALTER TABLE project_settings VALIDATE CONSTRAINT project_settings_aggregate_retention_check;

    CREATE TABLE IF NOT EXISTS notification_destinations (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      address TEXT NOT NULL,
      secret_ciphertext TEXT,
      event_types TEXT[] NOT NULL DEFAULT ARRAY['weekly_summary']::TEXT[],
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_delivery_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT notification_destinations_kind_check
        CHECK (kind IN ('email', 'webhook'))
    );
    CREATE INDEX IF NOT EXISTS idx_notification_destinations_org
      ON notification_destinations(org_id, enabled);

    CREATE TABLE IF NOT EXISTS notification_preferences (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      weekly_summary_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      weekly_summary_hour INTEGER NOT NULL DEFAULT 9,
      weekly_summary_weekday INTEGER NOT NULL DEFAULT 1,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      findings_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      policy_warning_thresholds DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[0.8, 1.0],
      enforcement_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      execution_receipts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (org_id, user_id, project_id),
      CONSTRAINT notification_preferences_hour_check CHECK (weekly_summary_hour BETWEEN 0 AND 23),
      CONSTRAINT notification_preferences_weekday_check CHECK (weekly_summary_weekday BETWEEN 0 AND 6)
    );
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS weekly_summary_enabled BOOLEAN;
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS weekly_summary_hour INTEGER;
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS weekly_summary_weekday INTEGER;
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS timezone TEXT;
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS findings_enabled BOOLEAN;
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS policy_warning_thresholds DOUBLE PRECISION[];
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS enforcement_enabled BOOLEAN;
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS execution_receipts_enabled BOOLEAN;
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
    UPDATE notification_preferences
       SET weekly_summary_enabled = COALESCE(weekly_summary_enabled, TRUE),
           weekly_summary_hour = CASE WHEN weekly_summary_hour BETWEEN 0 AND 23 THEN weekly_summary_hour ELSE 9 END,
           weekly_summary_weekday = CASE WHEN weekly_summary_weekday BETWEEN 0 AND 6 THEN weekly_summary_weekday ELSE 1 END,
           timezone = CASE WHEN timezone IS NULL OR btrim(timezone) = '' THEN 'UTC' ELSE timezone END,
           findings_enabled = COALESCE(findings_enabled, FALSE),
           policy_warning_thresholds = COALESCE(policy_warning_thresholds, ARRAY[0.8, 1.0]::DOUBLE PRECISION[]),
           enforcement_enabled = COALESCE(enforcement_enabled, TRUE),
           execution_receipts_enabled = COALESCE(execution_receipts_enabled, FALSE),
           created_at = COALESCE(created_at, NOW()),
           updated_at = COALESCE(updated_at, NOW());
    ALTER TABLE notification_preferences ALTER COLUMN weekly_summary_enabled SET DEFAULT TRUE;
    ALTER TABLE notification_preferences ALTER COLUMN weekly_summary_hour SET DEFAULT 9;
    ALTER TABLE notification_preferences ALTER COLUMN weekly_summary_weekday SET DEFAULT 1;
    ALTER TABLE notification_preferences ALTER COLUMN timezone SET DEFAULT 'UTC';
    ALTER TABLE notification_preferences ALTER COLUMN findings_enabled SET DEFAULT FALSE;
    ALTER TABLE notification_preferences ALTER COLUMN policy_warning_thresholds SET DEFAULT ARRAY[0.8, 1.0]::DOUBLE PRECISION[];
    ALTER TABLE notification_preferences ALTER COLUMN enforcement_enabled SET DEFAULT TRUE;
    ALTER TABLE notification_preferences ALTER COLUMN execution_receipts_enabled SET DEFAULT FALSE;
    ALTER TABLE notification_preferences ALTER COLUMN created_at SET DEFAULT NOW();
    ALTER TABLE notification_preferences ALTER COLUMN updated_at SET DEFAULT NOW();
    ALTER TABLE notification_preferences ALTER COLUMN weekly_summary_enabled SET NOT NULL;
    ALTER TABLE notification_preferences ALTER COLUMN weekly_summary_hour SET NOT NULL;
    ALTER TABLE notification_preferences ALTER COLUMN weekly_summary_weekday SET NOT NULL;
    ALTER TABLE notification_preferences ALTER COLUMN timezone SET NOT NULL;
    ALTER TABLE notification_preferences ALTER COLUMN findings_enabled SET NOT NULL;
    ALTER TABLE notification_preferences ALTER COLUMN policy_warning_thresholds SET NOT NULL;
    ALTER TABLE notification_preferences ALTER COLUMN enforcement_enabled SET NOT NULL;
    ALTER TABLE notification_preferences ALTER COLUMN execution_receipts_enabled SET NOT NULL;
    ALTER TABLE notification_preferences ALTER COLUMN created_at SET NOT NULL;
    ALTER TABLE notification_preferences ALTER COLUMN updated_at SET NOT NULL;
    DO $notification_preferences_checks$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'notification_preferences')) AND conname = 'notification_preferences_hour_check') THEN
        ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_hour_check CHECK (weekly_summary_hour BETWEEN 0 AND 23) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'notification_preferences')) AND conname = 'notification_preferences_weekday_check') THEN
        ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_weekday_check CHECK (weekly_summary_weekday BETWEEN 0 AND 6) NOT VALID;
      END IF;
    END $notification_preferences_checks$;
    ALTER TABLE notification_preferences VALIDATE CONSTRAINT notification_preferences_hour_check;
    ALTER TABLE notification_preferences VALIDATE CONSTRAINT notification_preferences_weekday_check;
    CREATE INDEX IF NOT EXISTS idx_notification_preferences_due
      ON notification_preferences(weekly_summary_enabled, weekly_summary_weekday, weekly_summary_hour);
    DELETE FROM notification_preferences p
     WHERE p.ctid <> (
         SELECT MIN(existing.ctid)
         FROM notification_preferences existing
         WHERE existing.org_id = p.org_id AND existing.user_id = p.user_id
           AND existing.project_id IS NOT DISTINCT FROM p.project_id
       );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_preferences_workspace
      ON notification_preferences(org_id, user_id) WHERE project_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_preferences_project
      ON notification_preferences(org_id, user_id, project_id) WHERE project_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      destination_id TEXT REFERENCES notification_destinations(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      scope_type TEXT,
      scope_id TEXT,
      dedupe_key TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::JSONB,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT notification_deliveries_status_check
        CHECK (status IN ('pending', 'sent', 'failed', 'suppressed'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_dedupe
      ON notification_deliveries(org_id, destination_id, dedupe_key)
      WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_org_created
      ON notification_deliveries(org_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS saved_views (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'view',
      visibility TEXT NOT NULL DEFAULT 'private',
      definition JSONB NOT NULL DEFAULT '{}'::JSONB,
      pinned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT saved_views_kind_check CHECK (kind IN ('view', 'scenario')),
      CONSTRAINT saved_views_visibility_check CHECK (visibility IN ('private', 'workspace'))
    );
    CREATE INDEX IF NOT EXISTS idx_saved_views_owner
      ON saved_views(org_id, owner_user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_saved_views_workspace
      ON saved_views(org_id, visibility, updated_at DESC);

    CREATE TABLE IF NOT EXISTS workspace_audit_log (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      details JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_audit_org_created
      ON workspace_audit_log(org_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS workspace_closure_requests (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'requested',
      impact JSONB NOT NULL DEFAULT '{}'::JSONB,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      CONSTRAINT workspace_closure_status_check
        CHECK (status IN ('requested', 'cancelled', 'completed'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_closure_pending
      ON workspace_closure_requests(org_id) WHERE status = 'requested';
    CREATE INDEX IF NOT EXISTS idx_workspace_closure_org_created
      ON workspace_closure_requests(org_id, requested_at DESC);

    CREATE TABLE IF NOT EXISTS subscriptions (
      org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'unconfigured',
      provider_customer_id TEXT,
      provider_subscription_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'not_configured',
      amount_cents INTEGER NOT NULL DEFAULT 900,
      currency TEXT NOT NULL DEFAULT 'usd',
      current_period_start TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
      cancel_at TIMESTAMPTZ,
      last_provider_event_at TIMESTAMPTZ,
      payment_method_summary TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_provider_event_at TIMESTAMPTZ;
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS seats INTEGER;
    ALTER TABLE subscriptions ALTER COLUMN amount_cents SET DEFAULT 900;

    CREATE TABLE IF NOT EXISTS subscription_invoices (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      provider_invoice_id TEXT UNIQUE,
      status TEXT NOT NULL,
      amount_due_cents INTEGER,
      amount_paid_cents INTEGER,
      currency TEXT NOT NULL DEFAULT 'usd',
      hosted_invoice_url TEXT,
      issued_at TIMESTAMPTZ,
      due_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscription_events (
      provider_event_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      org_id TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::JSONB,
      event_created_at TIMESTAMPTZ,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS retention_runs (
      id TEXT PRIMARY KEY,
      org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      deleted_events INTEGER NOT NULL DEFAULT 0,
      redacted_bodies INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    ALTER TABLE retention_runs ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE;

    -- Accounting publishes one immutable-through-day fence after its daily
    -- aggregate transaction commits. Retention will not purge detail without
    -- this checkpoint and uses source_created_before to keep late-arriving
    -- backfills safe.
    CREATE TABLE IF NOT EXISTS daily_cost_aggregate_checkpoints (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      through_day DATE NOT NULL,
      source_created_before TIMESTAMPTZ NOT NULL,
      generation BIGINT NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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
    UPDATE finding_thresholds SET
      expensive_sample = COALESCE(expensive_sample, 20), expensive_multiplier = COALESCE(expensive_multiplier, 3),
      expensive_min_absolute = COALESCE(expensive_min_absolute, 0.05), unit_sample = COALESCE(unit_sample, 20),
      unit_min_relative = COALESCE(unit_min_relative, 0.5), unit_min_impact = COALESCE(unit_min_impact, 1),
      coverage_min_drop = COALESCE(coverage_min_drop, 0.1), allowance_min_ratio = COALESCE(allowance_min_ratio, 0.8),
      updated_at = COALESCE(updated_at, NOW());
    INSERT INTO finding_thresholds(project_id)
      SELECT id FROM projects ON CONFLICT (project_id) DO NOTHING;

    -- Personal access tokens for coding agents (MCP). Only a SHA-256 hash of
    -- the token is stored; the token itself is shown once, at creation.
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_hint TEXT,
      scopes TEXT[] NOT NULL DEFAULT ARRAY['read']::text[],
      project_ids TEXT[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id, created_at DESC);

    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS webhook_secret_ciphertext TEXT;
    ALTER TABLE team_invites ADD COLUMN IF NOT EXISTS project_ids TEXT[];
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT;

    -- SDK envelope ids are only unique inside a project. Keep this migration
    -- here as well as the primary initializer because injected/harness pools
    -- intentionally skip initDatabase(). Existing ids and rows are preserved.
    DO $events_pk_platform$
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
    END $events_pk_platform$;
  `);
  await ensureDailyAggregateSchema(client);

  // Existing projects predate project_settings. Their old SDK contract
  // captured bodies, so preserve that behavior; only new project routes insert
  // metadata-only settings explicitly.
  const legacyRetention = Math.max(1, Number.parseInt(process.env["COSTKEY_RETENTION_DAYS"] ?? "90", 10) || 90);
  await client.query(`
    INSERT INTO workspace_settings(org_id, timezone, reporting_currency)
    SELECT id, 'UTC', 'USD' FROM orgs
    ON CONFLICT (org_id) DO NOTHING
  `);
  await client.query(`
    INSERT INTO project_settings (
      project_id, capture_mode, body_capture_enabled, redaction_enabled,
      body_retention_days, metadata_retention_days, aggregate_retention_days,
      source_access_enabled
    )
    SELECT p.id, 'text', TRUE, TRUE, $1, $1, 395, TRUE
    FROM projects p
    LEFT JOIN project_settings s ON s.project_id = p.id
    WHERE s.project_id IS NULL
    ON CONFLICT (project_id) DO NOTHING
  `, [legacyRetention]);

  // Legacy members had org-wide read access before assignments existed. Make
  // that compatibility migration one-shot; never repopulate assignments on a
  // later restart after an owner deliberately revokes a project.
  const migration = await client.query("SELECT 1 FROM migrations WHERE name = $1", ["platform_legacy_member_assignments_v1"]);
  if (migration.rows.length === 0) {
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO project_memberships (project_id, user_id, assigned_by)
        SELECT p.id, u.id, NULL
        FROM projects p
        JOIN users u ON u.org_id = p.org_id AND u.role = 'member'
        ON CONFLICT (project_id, user_id) DO NOTHING
      `);
      await client.query("UPDATE users SET role = 'developer' WHERE role = 'member'");
      await client.query("INSERT INTO migrations (name) VALUES ($1)", ["platform_legacy_member_assignments_v1"]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  // Screen capture: the project setting and the frame store.
  await ensureFramesSchema(client);
  });
}

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
