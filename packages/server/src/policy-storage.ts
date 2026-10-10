import type pg from "pg";
import { withMigrationLock } from "./db.js";

/**
 * Additive, idempotent storage for F06/DX09. The platform startup owns when
 * this is called. Admission never falls back to an in-process ledger when the
 * shared tables are unavailable.
 */
export async function ensurePolicySchema(pool: pg.Pool): Promise<void> {
  await withMigrationLock(pool, async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS spending_policies (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT,
      scope JSONB NOT NULL DEFAULT '{}'::jsonb,
      mode TEXT NOT NULL DEFAULT 'monitor'
        CHECK (mode IN ('monitor', 'enforce')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'archived')),
      unit TEXT NOT NULL CHECK (unit IN ('money', 'calls', 'tokens')),
      allowance DOUBLE PRECISION NOT NULL CHECK (allowance >= 0),
      currency TEXT,
      window_kind TEXT NOT NULL
        CHECK (window_kind IN ('per_trace', 'per_execution', 'calendar_minute', 'calendar_day', 'calendar_month')),
      timezone TEXT NOT NULL DEFAULT 'UTC',
      period_start_mode TEXT NOT NULL DEFAULT 'calendar'
        CHECK (period_start_mode IN ('calendar', 'activation')),
      activated_at TIMESTAMPTZ,
      usd_to_policy_currency DOUBLE PRECISION,
      -- Immutable-by-policy-version FX provenance copied from workspace_settings.
      fx_rate DOUBLE PRECISION,
      fx_source TEXT,
      fx_as_of TIMESTAMPTZ,
      capability_review JSONB,
      policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (unit <> 'money' OR (currency IS NOT NULL AND currency IN ('USD', 'INR'))),
      CHECK (unit <> 'money' OR currency <> 'INR' OR (
        COALESCE(fx_rate, usd_to_policy_currency) IS NOT NULL
        AND COALESCE(fx_rate, usd_to_policy_currency) > 0
        AND fx_source IS NOT NULL AND btrim(fx_source) <> ''
        AND fx_as_of IS NOT NULL
      ))
    );
    CREATE INDEX IF NOT EXISTS idx_spending_policies_project_status
      ON spending_policies(project_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_spending_policies_project_scope
      ON spending_policies USING GIN (scope);

    CREATE TABLE IF NOT EXISTS policy_window_usage (
      policy_id TEXT NOT NULL REFERENCES spending_policies(id) ON DELETE CASCADE,
      window_key TEXT NOT NULL,
      unit TEXT NOT NULL CHECK (unit IN ('money', 'calls', 'tokens')),
      currency TEXT,
      limit_quantity DOUBLE PRECISION NOT NULL CHECK (limit_quantity >= 0),
      reserved_quantity DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
      settled_quantity DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (settled_quantity >= 0),
      observed_quantity DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (observed_quantity >= 0),
      unknown_observations INTEGER NOT NULL DEFAULT 0 CHECK (unknown_observations >= 0),
      PRIMARY KEY (policy_id, window_key)
    );
    CREATE INDEX IF NOT EXISTS idx_policy_window_usage_policy
      ON policy_window_usage(policy_id, window_key);

    CREATE TABLE IF NOT EXISTS policy_observations (
      observation_id TEXT NOT NULL,
      policy_id TEXT NOT NULL REFERENCES spending_policies(id) ON DELETE CASCADE,
      window_key TEXT NOT NULL,
      quantity DOUBLE PRECISION CHECK (quantity IS NULL OR quantity >= 0),
      unknown BOOLEAN NOT NULL DEFAULT FALSE,
      occurred_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (policy_id, window_key, observation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_policy_observations_policy_time
      ON policy_observations(policy_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS policy_reservations (
      reservation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      admission_id TEXT NOT NULL,
      request_id TEXT,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'unknown', 'settled', 'released')),
      reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ,
      settlement_id TEXT,
      settlement_fingerprint TEXT,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success', 'failed', 'cancelled', 'unknown')),
      lines JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_reservations_admission
      ON policy_reservations(project_id, admission_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_reservations_request
      ON policy_reservations(project_id, request_id)
      WHERE request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_policy_reservations_project_state
      ON policy_reservations(project_id, state, reserved_at DESC);

    CREATE TABLE IF NOT EXISTS policy_decisions (
      id BIGSERIAL PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      policy_id TEXT REFERENCES spending_policies(id) ON DELETE SET NULL,
      policy_version INTEGER,
      admission_id TEXT NOT NULL,
      request_id TEXT,
      fingerprint TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('allow', 'refuse')),
      reservation_id TEXT,
      refusal JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_decisions_admission
      ON policy_decisions(project_id, admission_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_decisions_request
      ON policy_decisions(project_id, request_id)
      WHERE request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_policy_decisions_policy_time
      ON policy_decisions(project_id, policy_id, created_at DESC);
  `);

  // Safe for a table created by an earlier canary version. These are additive
  // and do not rewrite existing rows or release any in-flight reservation.
  await client.query(`
    ALTER TABLE spending_policies ADD COLUMN IF NOT EXISTS capability_review JSONB;
    ALTER TABLE spending_policies ADD COLUMN IF NOT EXISTS policy_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE spending_policies ADD COLUMN IF NOT EXISTS period_start_mode TEXT NOT NULL DEFAULT 'calendar';
    ALTER TABLE spending_policies ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
    ALTER TABLE spending_policies ADD COLUMN IF NOT EXISTS fx_rate DOUBLE PRECISION;
    ALTER TABLE spending_policies ADD COLUMN IF NOT EXISTS fx_source TEXT;
    ALTER TABLE spending_policies ADD COLUMN IF NOT EXISTS fx_as_of TIMESTAMPTZ;
    ALTER TABLE policy_reservations ADD COLUMN IF NOT EXISTS settlement_fingerprint TEXT;
    ALTER TABLE policy_window_usage ADD COLUMN IF NOT EXISTS observed_quantity DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE policy_window_usage ADD COLUMN IF NOT EXISTS unknown_observations INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE policy_observations ALTER COLUMN quantity DROP NOT NULL;
    ALTER TABLE policy_observations ADD COLUMN IF NOT EXISTS unknown BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE policy_decisions ADD COLUMN IF NOT EXISTS policy_id TEXT;
    ALTER TABLE policy_decisions ADD COLUMN IF NOT EXISTS policy_version INTEGER;
  `);
  });
}
