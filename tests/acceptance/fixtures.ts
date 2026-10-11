import bcrypt from "bcryptjs";
import pg from "pg";

export const ACCEPTANCE_PASSWORD = "acceptance-pass";
export const ACCEPTANCE_ORG_ID = "org_acceptance_local";
export const ACCEPTANCE_PROJECT_ID = "proj_acceptance_local";
export const ACCEPTANCE_PROJECT_KEY = "ck_acceptance_local";
export const OTHER_ORG_ID = "org_acceptance_other";
export const OTHER_PROJECT_ID = "proj_acceptance_other";
export const OTHER_PROJECT_KEY = "ck_acceptance_other";
export const CROSS_SDK_TRACE_ID = "trace_acceptance_cross_sdk";
export const CROSS_SDK_TRACE_NAME = "cross-sdk-voice";

export const ROLE_USER_IDS = {
  owner: "usr_acceptance_owner",
  admin: "usr_acceptance_admin",
  developer: "usr_acceptance_developer",
  viewer: "usr_acceptance_viewer",
} as const;

export type AcceptanceRole = keyof typeof ROLE_USER_IDS;

export interface AcceptanceFixture {
  orgId: string;
  projectId: string;
  projectKey: string;
  otherOrgId: string;
  otherProjectId: string;
  otherProjectKey: string;
  roleUserIds: typeof ROLE_USER_IDS;
  eventIds: {
    known: string;
    retry: string;
    unpriced: string;
    unassigned: string;
    bundled: string;
    otherOrg: string;
    ingested: string;
  };
  traceId: string;
  sensitiveMarker: string;
  platformSchemaBootstrapped: boolean;
}

const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

/**
 * Seed a deterministic, local-only project after the server has initialized
 * its schema. These rows are synthetic fixtures. They prove HTTP/database
 * wiring and authorization boundaries only; they do not prove a provider SDK
 * or deployed delivery integration.
 */
export async function seedAcceptanceFixtures(pool: pg.Pool): Promise<AcceptanceFixture> {
  await pool.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT");
  // The application-owned platform startup hook should create these tables.
  // Keep a deliberately small local compatibility bootstrap so the harness
  // can still exercise the legacy HTTP surface while another agent wires that
  // hook into server startup. Its use is reported as a blocker and never
  // counts as platform-schema acceptance evidence.
  const platformTables = await pool.query<{ settings: string | null; memberships: string | null }>(
    "SELECT to_regclass('public.project_settings') AS settings, to_regclass('public.project_memberships') AS memberships",
  );
  const platformSchemaBootstrapped = !platformTables.rows[0]?.settings || !platformTables.rows[0]?.memberships;
  if (platformSchemaBootstrapped) {
    await pool.query(`
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT;
      CREATE TABLE IF NOT EXISTS project_memberships (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS project_settings (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        capture_mode TEXT NOT NULL DEFAULT 'metadata',
        body_capture_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        redaction_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        body_retention_days INTEGER NOT NULL DEFAULT 7,
        metadata_retention_days INTEGER NOT NULL DEFAULT 30,
        aggregate_retention_days INTEGER NOT NULL DEFAULT 395,
        source_access_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  const passwordHash = await bcrypt.hash(ACCEPTANCE_PASSWORD, 4);

  await pool.query(
    `INSERT INTO orgs (id, name, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug`,
    [ACCEPTANCE_ORG_ID, "CostKey Acceptance Local", "acceptance-local"],
  );

  await pool.query(
    `INSERT INTO projects (id, name, org_id, auth_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, org_id = EXCLUDED.org_id, auth_key = EXCLUDED.auth_key`,
    [ACCEPTANCE_PROJECT_ID, "Acceptance Fixture", ACCEPTANCE_ORG_ID, ACCEPTANCE_PROJECT_KEY],
  );

  const users: Array<[string, string, string, AcceptanceRole]> = [
    [ROLE_USER_IDS.owner, "owner@acceptance.invalid", "Acceptance Owner", "owner"],
    [ROLE_USER_IDS.admin, "admin@acceptance.invalid", "Acceptance Admin", "admin"],
    [ROLE_USER_IDS.developer, "developer@acceptance.invalid", "Acceptance Developer", "developer"],
    [ROLE_USER_IDS.viewer, "viewer@acceptance.invalid", "Acceptance Viewer", "viewer"],
  ];
  for (const [id, email, name, role] of users) {
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, org_id, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         name = EXCLUDED.name,
         org_id = EXCLUDED.org_id,
         role = EXCLUDED.role`,
      [id, email, passwordHash, name, ACCEPTANCE_ORG_ID, role],
    );
  }

  await pool.query(
    `INSERT INTO project_memberships (project_id, user_id, assigned_by)
     VALUES ($1, $2, $3), ($1, $4, $3)
     ON CONFLICT (project_id, user_id) DO NOTHING`,
    [ACCEPTANCE_PROJECT_ID, ROLE_USER_IDS.developer, ROLE_USER_IDS.owner, ROLE_USER_IDS.viewer],
  );

  await pool.query(
    `INSERT INTO orgs (id, name, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug`,
    [OTHER_ORG_ID, "CostKey Acceptance Other", "acceptance-other"],
  );
  await pool.query(
    `INSERT INTO projects (id, name, org_id, auth_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, org_id = EXCLUDED.org_id, auth_key = EXCLUDED.auth_key`,
    [OTHER_PROJECT_ID, "Other Org Fixture", OTHER_ORG_ID, OTHER_PROJECT_KEY],
  );
  await pool.query(
    `INSERT INTO project_settings (
       project_id, capture_mode, body_capture_enabled, redaction_enabled,
       body_retention_days, metadata_retention_days, aggregate_retention_days,
       source_access_enabled
     ) VALUES
       ($1, 'metadata', FALSE, TRUE, 7, 30, 395, TRUE),
       ($2, 'metadata', FALSE, TRUE, 7, 30, 395, FALSE)
     ON CONFLICT (project_id) DO UPDATE SET
       capture_mode = EXCLUDED.capture_mode,
       body_capture_enabled = EXCLUDED.body_capture_enabled,
       redaction_enabled = EXCLUDED.redaction_enabled,
       body_retention_days = EXCLUDED.body_retention_days,
       metadata_retention_days = EXCLUDED.metadata_retention_days,
       aggregate_retention_days = EXCLUDED.aggregate_retention_days,
       source_access_enabled = EXCLUDED.source_access_enabled`,
    [ACCEPTANCE_PROJECT_ID, OTHER_PROJECT_ID],
  );
  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, org_id, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       password_hash = EXCLUDED.password_hash,
       name = EXCLUDED.name,
       org_id = EXCLUDED.org_id,
       role = EXCLUDED.role`,
    ["usr_acceptance_other", "other@acceptance.invalid", "not-used", "Other Org User", OTHER_ORG_ID, "owner"],
  );

  const traceId = "trace_acceptance_search";
  const sensitiveMarker = "acceptance-body-marker-never-a-secret";
  const eventRows = [
    {
      id: "evt_acceptance_known",
      timestamp: iso(-3_000),
      projectId: ACCEPTANCE_PROJECT_ID,
      provider: "openai",
      model: "gpt-4o",
      statusCode: 200,
      inputTokens: 1_000,
      outputTokens: 500,
      totalTokens: 1_500,
      costUsd: 0.0075,
      durationMs: 120,
      traceId,
      traceName: "acceptance-search",
      context: { feature: "search", customer: "customer_1", environment: "test", runtime: "python", traceId, traceName: "acceptance-search" },
      metadata: { attemptId: "attempt-known", source: "fixture" },
      requestBody: { messages: [{ role: "user", content: sensitiveMarker }] },
      responseBody: { choices: [{ message: { role: "assistant", content: "fixture completion" } }] },
      frames: [{ fileName: "src/search.py", functionName: "search", lineNumber: 11, columnNumber: 1 }],
      blFunction: "search",
      blFile: "src/search.py",
      blLine: 11,
    },
    {
      id: "evt_acceptance_retry",
      timestamp: iso(-2_000),
      projectId: ACCEPTANCE_PROJECT_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      statusCode: 200,
      inputTokens: 2_000,
      outputTokens: 800,
      totalTokens: 2_800,
      costUsd: 0.00078,
      durationMs: 210,
      traceId,
      traceName: "acceptance-search",
      context: { feature: "search", customer: "customer_1", environment: "test", runtime: "typescript", traceId, traceName: "acceptance-search" },
      metadata: { attemptId: "attempt-retry", retryOf: "attempt-known", returnedModel: "gpt-4o-mini", source: "fixture" },
      requestBody: { input: sensitiveMarker },
      responseBody: { output: "fixture retry completion" },
      frames: [{ fileName: "src/search.ts", functionName: "search", lineNumber: 22, columnNumber: 1 }],
      blFunction: "search",
      blFile: "src/search.ts",
      blLine: 22,
    },
    {
      id: "evt_acceptance_unpriced",
      timestamp: iso(-1_000),
      projectId: ACCEPTANCE_PROJECT_ID,
      provider: "custom-acceptance",
      model: "unknown-acceptance-model",
      statusCode: 200,
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      costUsd: null,
      durationMs: 90,
      traceId,
      traceName: "acceptance-search",
      context: { feature: "search", customer: "customer_1", environment: "test", traceId, traceName: "acceptance-search" },
      metadata: { attemptId: "attempt-unpriced", source: "fixture" },
      requestBody: { input: "unpriced fixture" },
      responseBody: { output: "unpriced fixture" },
      frames: [{ fileName: "src/search.ts", functionName: "search", lineNumber: 30, columnNumber: 1 }],
      blFunction: "search",
      blFile: "src/search.ts",
      blLine: 30,
    },
    {
      id: "evt_acceptance_unassigned",
      timestamp: iso(-750),
      projectId: ACCEPTANCE_PROJECT_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      statusCode: 200,
      inputTokens: 700,
      outputTokens: 150,
      totalTokens: 850,
      costUsd: 0.0012,
      durationMs: 105,
      traceId: "trace_acceptance_unassigned",
      traceName: "acceptance-unassigned",
      context: { customer: "customer_2", environment: "test", service: "worker", traceId: "trace_acceptance_unassigned", traceName: "acceptance-unassigned" },
      metadata: { source: "fixture", cohort: "feature-mapping" },
      requestBody: null,
      responseBody: null,
      frames: [{ fileName: "src/worker.ts", functionName: "runWorker", lineNumber: 17, columnNumber: 1 }],
      blFunction: "runWorker",
      blFile: "src/worker.ts",
      blLine: 17,
    },
    {
      id: "evt_acceptance_bundled",
      timestamp: iso(-500),
      projectId: ACCEPTANCE_PROJECT_ID,
      provider: "openai",
      model: "gpt-4o",
      statusCode: 200,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.00075,
      durationMs: 45,
      traceId: "trace_acceptance_bundled",
      traceName: "acceptance-bundled",
      context: { environment: "test", traceId: "trace_acceptance_bundled", traceName: "acceptance-bundled" },
      metadata: { source: "fixture" },
      requestBody: null,
      responseBody: null,
      frames: [{ fileName: "/app/.next/server/chunks/123.js", functionName: null, lineNumber: 1, columnNumber: 1 }],
      blFunction: null,
      blFile: null,
      blLine: null,
    },
    {
      id: "evt_acceptance_other_org",
      timestamp: iso(-700),
      projectId: OTHER_PROJECT_ID,
      provider: "openai",
      model: "gpt-4o",
      statusCode: 200,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.00075,
      durationMs: 30,
      traceId: "trace_acceptance_other",
      traceName: "other-org",
      context: { environment: "other", traceId: "trace_acceptance_other", traceName: "other-org" },
      metadata: { source: "fixture" },
      requestBody: { input: "other-org-body" },
      responseBody: { output: "other-org-body" },
      frames: [{ fileName: "other.ts", functionName: "other", lineNumber: 1, columnNumber: 1 }],
      blFunction: "other",
      blFile: "other.ts",
      blLine: 1,
    },
  ] as const;

  for (const row of eventRows) {
    await pool.query(
      `INSERT INTO events (
        id, timestamp, project_id, provider, model, url, method, status_code,
        input_tokens, output_tokens, total_tokens, cost_usd, duration_ms,
        streaming, trace_id, trace_name, context, metadata, request_body,
        response_body, call_site_frames, bl_function, bl_file, bl_line, release
      ) VALUES (
        $1, $2, $3, $4, $5, 'https://local.acceptance.invalid/v1/chat', 'POST', $6,
        $7, $8, $9, $10, $11, FALSE, $12, $13, $14, $15, $16, $17, $18, $19,
        $20, $21, 'acceptance'
      )
      ON CONFLICT (project_id, id) DO UPDATE SET
        timestamp = EXCLUDED.timestamp,
        project_id = EXCLUDED.project_id,
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        status_code = EXCLUDED.status_code,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        total_tokens = EXCLUDED.total_tokens,
        cost_usd = EXCLUDED.cost_usd,
        duration_ms = EXCLUDED.duration_ms,
        trace_id = EXCLUDED.trace_id,
        trace_name = EXCLUDED.trace_name,
        context = EXCLUDED.context,
        metadata = EXCLUDED.metadata,
        request_body = EXCLUDED.request_body,
        response_body = EXCLUDED.response_body,
        call_site_frames = EXCLUDED.call_site_frames,
        bl_function = EXCLUDED.bl_function,
        bl_file = EXCLUDED.bl_file,
        bl_line = EXCLUDED.bl_line,
        release = EXCLUDED.release`,
      [
        row.id,
        row.timestamp,
        row.projectId,
        row.provider,
        row.model,
        row.statusCode,
        row.inputTokens,
        row.outputTokens,
        row.totalTokens,
        row.costUsd,
        row.durationMs,
        row.traceId,
        row.traceName,
        JSON.stringify(row.context),
        JSON.stringify(row.metadata),
        row.requestBody ? JSON.stringify(row.requestBody) : null,
        row.responseBody ? JSON.stringify(row.responseBody) : null,
        JSON.stringify(row.frames),
        row.blFunction,
        row.blFile,
        row.blLine,
      ],
    );
  }
  // Direct body-bearing fixture rows model content that was actually
  // captured; otherwise the export serializer correctly treats the default
  // `unknown` status as unavailable even for an Owner.
  await pool.query(
    `UPDATE events SET content_status = 'captured'
     WHERE project_id = $1
       AND (request_body IS NOT NULL OR response_body IS NOT NULL OR system_prompt IS NOT NULL)`,
    [ACCEPTANCE_PROJECT_ID],
  );

  const callSites = [
    ["src/search.py:search:11", "src/search.py", "search", 11, "openai", "gpt-4o", 1, 0.0075, 1_000, 500],
    ["src/search.ts:search:22", "src/search.ts", "search", 22, "openai", "gpt-4o-mini", 1, 0.00078, 2_000, 800],
    ["src/search.ts:search:30", "src/search.ts", "search", 30, "custom-acceptance", "unknown-acceptance-model", 1, 0, 500, 100],
  ] as const;
  for (const [key, file, fn, line, provider, model, calls, cost, input, output] of callSites) {
    await pool.query(
      `INSERT INTO call_site_stats (
        project_id, call_site_key, file_name, function_name, line_number,
        provider, model, total_calls, total_cost_usd, total_input_tokens,
        total_output_tokens, avg_duration_ms, first_seen, last_seen
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 100, NOW(), NOW())
      ON CONFLICT (project_id, call_site_key, model) DO UPDATE SET
        total_calls = EXCLUDED.total_calls,
        total_cost_usd = EXCLUDED.total_cost_usd,
        total_input_tokens = EXCLUDED.total_input_tokens,
        total_output_tokens = EXCLUDED.total_output_tokens,
        last_seen = EXCLUDED.last_seen`,
      [ACCEPTANCE_PROJECT_ID, key, file, fn, line, provider, model, calls, cost, input, output],
    );
  }

  // Seed one factual finding record so the local route test can verify the
  // evidence/chronology shape without relying on statistical noise from a
  // handful of synthetic calls. This is fixture evidence, not a claim that
  // the detector is calibrated for production traffic.
  const findingNow = iso(-250);
  await pool.query(
    `INSERT INTO findings (
       id, project_id, family, scope, state, observed_at, last_seen_at,
       baseline, evidence, next_actions, occurrence_count
     ) VALUES ($1, $2, 'pricing_coverage', $3, 'new', $4, $4, $5, $6, $7, 1)
     ON CONFLICT (id) DO UPDATE SET
       scope = EXCLUDED.scope,
       state = EXCLUDED.state,
       observed_at = EXCLUDED.observed_at,
       last_seen_at = EXCLUDED.last_seen_at,
       baseline = EXCLUDED.baseline,
       evidence = EXCLUDED.evidence,
       next_actions = EXCLUDED.next_actions,
       occurrence_count = EXCLUDED.occurrence_count`,
    [
      "finding_acceptance_coverage",
      ACCEPTANCE_PROJECT_ID,
      JSON.stringify({ environment: "test", provider: "custom-acceptance" }),
      findingNow,
      JSON.stringify({ comparison: "prior_7_days", sampleSufficient: false }),
      JSON.stringify({ sampleSufficient: false, supportingTraceIds: [traceId], pricedCoverage: 0.75 }),
      JSON.stringify(["inspect unknown-price calls"]),
    ],
  );

  return {
    orgId: ACCEPTANCE_ORG_ID,
    projectId: ACCEPTANCE_PROJECT_ID,
    projectKey: ACCEPTANCE_PROJECT_KEY,
    otherOrgId: OTHER_ORG_ID,
    otherProjectId: OTHER_PROJECT_ID,
    otherProjectKey: OTHER_PROJECT_KEY,
    roleUserIds: ROLE_USER_IDS,
    eventIds: {
      known: "evt_acceptance_known",
      retry: "evt_acceptance_retry",
      unpriced: "evt_acceptance_unpriced",
      unassigned: "evt_acceptance_unassigned",
      bundled: "evt_acceptance_bundled",
      otherOrg: "evt_acceptance_other_org",
      ingested: "evt_acceptance_ingested",
    },
    traceId,
    sensitiveMarker,
    platformSchemaBootstrapped,
  };
}
