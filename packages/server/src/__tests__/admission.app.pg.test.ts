import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import pg from "pg";
import { createServer, type Server } from "node:http";
import { createApp } from "../index.js";
import { runBudgetChecks } from "../budgets.js";
import { createPostgresObservedUsageSource, normalizeSpendingPolicy } from "../admission.js";

/**
 * Opt-in smoke test for the actual production-schema app boundary. Unlike
 * admission.pg.test.ts, this deliberately does not create an alternate schema
 * or hand-written tables: it exercises startup DDL, the authenticated console
 * CRUD routes, the DSN SDK routes, and the legacy compatibility route against
 * a supplied local acceptance database.
 *
 * Set COSTKEY_APP_TEST_DATABASE_URL (or ACCEPTANCE_DATABASE_URL) to run it.
 * The test chooses one existing owner/admin project, uses unique policy and
 * admission IDs, and restores the workspace FX row in finally.
 */
const connectionString = process.env["COSTKEY_APP_TEST_DATABASE_URL"] ?? process.env["ACCEPTANCE_DATABASE_URL"];
const canRun = Boolean(connectionString);

type Fixture = {
  projectId: string;
  authKey: string;
  orgId: string;
  userId: string;
  role: string;
};

type WorkspaceRow = {
  timezone: string | null;
  reporting_currency: string | null;
  fx_rate: number | null;
  fx_source: string | null;
  fx_as_of: Date | string | null;
  updated_by: string | null;
};

function uniquePrefix(): string {
  return `app_p0_${process.pid}_${randomBytes(5).toString("hex")}`;
}

async function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body, headers: response.headers };
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; url: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test("F06/DX09 full production-schema app boundary", { skip: !canRun }, async () => {
  assert.ok(connectionString);
  const pool = new pg.Pool({ connectionString, max: 8 });
  const prefix = uniquePrefix();
  const policyIds: string[] = [];
  let fixture: Fixture | null = null;
  let previousWorkspace: WorkspaceRow | null = null;
  let runtime: ReturnType<typeof createApp> | null = null;
  let server: Server | null = null;
  const previousAcceptanceBase = process.env["ACCEPTANCE_BASE_URL"];
  const previousAcceptanceDatabase = process.env["ACCEPTANCE_DATABASE_URL"];

  try {
    // Startup uses the real additive schema path before mounting canonical
    // budget routes. There is intentionally no test DDL here.
    runtime = createApp({ pool, includeDashboard: false, initialize: false, startSchedulers: false });
    await runtime.initialize();

    const fixtureResult = await pool.query<Fixture>(
      `SELECT p.id AS "projectId", p.auth_key AS "authKey", p.org_id AS "orgId",
              u.id AS "userId", u.role
       FROM projects p
       JOIN users u ON u.org_id = p.org_id
       WHERE LOWER(u.role) IN ('owner', 'admin')
       ORDER BY p.id ASC
       LIMIT 1`,
    );
    fixture = fixtureResult.rows[0] ?? null;
    assert.ok(fixture, "acceptance database needs an owner/admin project fixture");

    const workspaceResult = await pool.query<WorkspaceRow>(
      `SELECT timezone, reporting_currency, fx_rate, fx_source, fx_as_of, updated_by
       FROM workspace_settings WHERE org_id = $1`,
      [fixture.orgId],
    );
    previousWorkspace = workspaceResult.rows[0] ?? null;

    const jwtSecret = process.env["COSTKEY_JWT_SECRET"] ?? "costkey-test-only-secret";
    const dashboardToken = jwt.sign(
      { userId: fixture.userId, orgId: fixture.orgId, role: fixture.role },
      jwtSecret,
      { expiresIn: "5m" },
    );
    const dashboardAuth = { Authorization: `Bearer ${dashboardToken}` };
    const started = await listen(runtime);
    server = started.server;
    // The local harness is the explicit server-controlled attestation source
    // for this synthetic settlement. A public DSN caller cannot self-enable
    // this path in production; the security boundary rejects raw actuals.
    process.env["ACCEPTANCE_BASE_URL"] = started.url;
    process.env["ACCEPTANCE_DATABASE_URL"] = connectionString;

    const asOf = new Date(Date.now() - 1_000).toISOString();
    const fxUpdate = await request(started.url, "/api/v1/workspace/settings", {
      method: "PATCH",
      headers: dashboardAuth,
      body: JSON.stringify({ reportingCurrency: "INR", fxRate: 80, fxSource: `${prefix}-workspace`, fxAsOf: asOf }),
    });
    assert.equal(fxUpdate.status, 200);
    assert.equal(fxUpdate.body.settings.fx.rate, 80);

    const inrPolicyBody = {
      name: `${prefix}-inr`,
      scope: {},
      mode: "monitor",
      status: "active",
      unit: "money",
      allowance: 8000,
      currency: "INR",
      window: "calendar_day",
      timezone: "UTC",
      periodStart: "calendar",
      // Deliberately malicious/stale client claim. The route must use the
      // saved workspace basis and expose that the claim was ignored.
      usdToPolicyCurrency: 1,
    };
    const preview = await request(started.url, `/api/v1/projects/${fixture.projectId}/budget/policies/preview`, {
      method: "POST",
      headers: dashboardAuth,
      body: JSON.stringify(inrPolicyBody),
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.fx.rate, 80);
    assert.equal(preview.body.fxClientClaimIgnored, true);
    assert.deepEqual(preview.body.scopeReview.wildcardFields, []);
    assert.ok(Array.isArray(preview.body.scopeReview.overlappingPolicies));
    const createdInr = await request(started.url, `/api/v1/projects/${fixture.projectId}/budget/policies`, {
      method: "POST",
      headers: dashboardAuth,
      body: JSON.stringify(inrPolicyBody),
    });
    assert.equal(createdInr.status, 201);
    assert.equal(createdInr.body.policy.fx.rate, 80);
    assert.equal(createdInr.body.policy.usdToPolicyCurrency, 80);
    policyIds.push(String(createdInr.body.id));

    const detail = await request(started.url, `/api/v1/projects/${fixture.projectId}/budget/policies/${createdInr.body.id}`, {
      headers: dashboardAuth,
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.policy.fx.source, `${prefix}-workspace`);
    assert.equal(detail.body.policy.policyVersion, 1);

    const unsupportedPreview = await request(started.url, `/api/v1/projects/${fixture.projectId}/budget/policies/preview`, {
      method: "POST",
      headers: dashboardAuth,
      body: JSON.stringify({
        name: `${prefix}-unsupported-preview`, scope: { provider: `${prefix}-unknown-provider` },
        mode: "enforce", status: "active", unit: "calls", allowance: 1,
        window: "calendar_day", timezone: "UTC", periodStart: "calendar",
        capabilityReview: { supported: true, admissionSupported: true, verified: true },
      }),
    });
    assert.equal(unsupportedPreview.status, 200);
    assert.equal(unsupportedPreview.body.capability.source, "server_registry");
    assert.equal(unsupportedPreview.body.capability.verified, false);
    const unsupportedCreate = await request(started.url, `/api/v1/projects/${fixture.projectId}/budget/policies`, {
      method: "POST",
      headers: dashboardAuth,
      body: JSON.stringify({
        name: `${prefix}-unsupported-create`, scope: { provider: `${prefix}-unknown-provider` },
        mode: "enforce", status: "active", unit: "calls", allowance: 1,
        window: "calendar_day", timezone: "UTC", periodStart: "calendar",
        capabilityReview: { supported: true, admissionSupported: true, verified: true },
      }),
    });
    assert.equal(unsupportedCreate.status, 409);
    assert.equal(unsupportedCreate.body.reason, "unsupported_integration");

    // The admission source is the same reconciled charges relation used by
    // Costs/Forecast: an explicit usage component must consume the shared
    // allowance, rather than disappearing because it is not an events row.
    const explicitUsageId = `${prefix}-voice-usage`;
    await pool.query(
      `INSERT INTO usage_components (
         id, project_id, charge_id, component_id, context, component,
         provider, model, amount, currency, amount_kind, aggregation,
         revision, observed_at, accounting_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,'tts','openai','gpt-4o-mini',0.8,'USD','reported','delta',0,$6,$6)`,
      [explicitUsageId, fixture.projectId, `${prefix}-voice-charge`, "tts", JSON.stringify({ group: prefix }), new Date().toISOString()],
    );
    const usagePolicy = await request(started.url, `/api/v1/projects/${fixture.projectId}/budget/policies`, {
      method: "POST",
      headers: dashboardAuth,
      body: JSON.stringify({
        name: `${prefix}-explicit-usage`,
        scope: { group: prefix },
        mode: "enforce",
        status: "active",
        unit: "money",
        allowance: 0.8,
        currency: "USD",
        window: "calendar_day",
        timezone: "UTC",
        periodStart: "calendar",
      }),
    });
    assert.equal(usagePolicy.status, 201);
    policyIds.push(String(usagePolicy.body.id));
    const usageRefusal = await request(started.url, "/api/v1/sdk/policy/admit", {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.authKey}` },
      body: JSON.stringify({
        projectId: fixture.projectId,
        admissionId: `${prefix}-explicit-admit`,
        requestId: `${prefix}-explicit-request`,
        provider: "openai",
        model: "gpt-4o-mini",
        scope: { group: prefix },
        integration: { supported: true, admissionSupported: true, verified: true },
        usageBounds: { maxInputTokens: 10_000, maxOutputTokens: 10_000 },
      }),
    });
    assert.equal(usageRefusal.status, 429);
    assert.equal(usageRefusal.body.decision, "refuse");
    assert.equal(usageRefusal.body.reason, "budget_exhausted");

    const destinationId = `${prefix}-notifications`;
    await pool.query(
      `INSERT INTO notification_destinations (
         id, org_id, project_id, owner_user_id, kind, address, event_types
       ) VALUES ($1,$2,$3,$4,'email',$5,ARRAY['policy_warning','enforcement','finding']::text[])`,
      [destinationId, fixture.orgId, fixture.projectId, fixture.userId, `${prefix}@example.invalid`],
    );
    const repeatedRefusal = await request(started.url, "/api/v1/sdk/policy/admit", {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.authKey}` },
      body: JSON.stringify({
        projectId: fixture.projectId,
        admissionId: `${prefix}-explicit-admit-retry`,
        requestId: `${prefix}-explicit-request-retry`,
        provider: "openai",
        model: "gpt-4o-mini",
        scope: { group: prefix },
        integration: { supported: true, admissionSupported: true, verified: true },
        usageBounds: { maxInputTokens: 10_000, maxOutputTokens: 10_000 },
      }),
    });
    assert.equal(repeatedRefusal.status, 429);
    const refusalNotificationCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notification_deliveries
       WHERE org_id = $1 AND destination_id = $2 AND event_type = 'enforcement'`,
      [fixture.orgId, destinationId],
    );
    assert.equal(Number(refusalNotificationCount.rows[0]?.count), 1, "repeated refusals should share one idempotent enforcement notification");
    await runBudgetChecks(pool);
    const firstWarningCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notification_deliveries
       WHERE org_id = $1 AND dedupe_key LIKE $2 AND event_type = 'policy_warning'`,
      [fixture.orgId, `policy_warning:${fixture.projectId}:${usagePolicy.body.id}:%`],
    );
    assert.equal(Number(firstWarningCount.rows[0]?.count), 2, "canonical warning thresholds should enqueue 80% and 100% once");
    await runBudgetChecks(pool);
    const replayWarningCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notification_deliveries
       WHERE org_id = $1 AND dedupe_key LIKE $2 AND event_type = 'policy_warning'`,
      [fixture.orgId, `policy_warning:${fixture.projectId}:${usagePolicy.body.id}:%`],
    );
    assert.equal(Number(replayWarningCount.rows[0]?.count), 2, "repeated policy checks must be idempotent");
    const findingNotificationCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notification_deliveries
       WHERE org_id = $1 AND destination_id = $2 AND event_type = 'finding'`,
      [fixture.orgId, destinationId],
    );
    assert.equal(Number(findingNotificationCount.rows[0]?.count), 1, "canonical allowance trajectory should persist and notify once");
    await pool.query("DELETE FROM usage_components WHERE project_id = $1 AND id = $2", [fixture.projectId, explicitUsageId]);
    await pool.query("DELETE FROM notification_deliveries WHERE org_id = $1 AND destination_id = $2", [fixture.orgId, destinationId]);
    await pool.query("DELETE FROM notification_destinations WHERE id = $1", [destinationId]);

    const enforcedPolicy = await request(started.url, `/api/v1/projects/${fixture.projectId}/budget/policies`, {
      method: "POST",
      headers: dashboardAuth,
      body: JSON.stringify({
        name: `${prefix}-enforced`,
        scope: { group: `${prefix}-call` },
        mode: "enforce",
        status: "active",
        unit: "money",
        allowance: 1,
        currency: "USD",
        window: "calendar_day",
        timezone: "UTC",
        periodStart: "calendar",
        // A caller cannot activate enforcement by asserting capability; the
        // server derives the persisted review from its own provider registry.
        capabilityReview: { supported: false, admissionSupported: false, verified: false, capabilityVersion: "attacker/1" },
      }),
    });
    assert.equal(enforcedPolicy.status, 201);
    assert.equal(enforcedPolicy.body.policy.capability.source, "server_registry");
    assert.equal(enforcedPolicy.body.policy.capability.verified, true);
    policyIds.push(String(enforcedPolicy.body.id));

    const admissionId = `${prefix}-admit`;
    const admission = await request(started.url, "/api/v1/sdk/policy/admit", {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.authKey}` },
      body: JSON.stringify({
        projectId: fixture.projectId,
        admissionId,
        requestId: `${prefix}-request`,
        provider: "openai",
        model: "gpt-4o-mini",
        scope: { group: `${prefix}-call` },
        // The server registry, not these caller booleans, authorizes the
        // registered OpenAI transport for this decision.
        integration: { supported: false, admissionSupported: false, verified: false, capabilityVersion: "attacker/1" },
        usageBounds: { maxInputTokens: 10_000, maxOutputTokens: 10_000 },
        claimedCostUsd: 0,
      }),
    });
    assert.equal(admission.status, 200);
    assert.equal(admission.body.decision, "allow");
    assert.equal(admission.body.providerCallAllowed, true);
    assert.ok(admission.body.reservationId);

    // If an automatic event has no price and an explicit component later
    // supplies the same charge, the canonical CTE may select the explicit
    // row. The reservation exclusion must still remove that charge key while
    // the admitted attempt is in flight (and after settlement).
    const attemptedEventId = `${prefix}-attempt-event`;
    const attemptedChargeId = `${prefix}-attempt-charge`;
    const attemptedUsageId = `${prefix}-attempt-usage`;
    await pool.query(
      `INSERT INTO events (id, project_id, timestamp, provider, model, group_name, context, attempt_id, charge_id, cost_usd)
       VALUES ($1,$2,$3,'openai','gpt-4o-mini',$4,$5::jsonb,$6,$7,NULL)`,
      [attemptedEventId, fixture.projectId, new Date().toISOString(), `${prefix}-call`, JSON.stringify({ group: `${prefix}-call` }), admissionId, attemptedChargeId],
    );
    await pool.query(
      `INSERT INTO usage_components (
         id, project_id, charge_id, component_id, context, component,
         provider, model, amount, currency, amount_kind, aggregation,
         revision, observed_at, accounting_at
       ) VALUES ($1,$2,$3,'tts',$4::jsonb,'tts','openai','gpt-4o-mini',0.5,'USD','reported','delta',0,$5,$5)`,
      [attemptedUsageId, fixture.projectId, attemptedChargeId, JSON.stringify({ group: `${prefix}-call` }), new Date().toISOString()],
    );
    const policyRow = await pool.query("SELECT * FROM spending_policies WHERE id = $1", [enforcedPolicy.body.id]);
    const observedAttempt = await createPostgresObservedUsageSource(pool)(
      normalizeSpendingPolicy(policyRow.rows[0] as Record<string, unknown>),
      String(admission.body.reservation?.lines?.[0]?.windowKey ?? ""),
      {
        projectId: fixture.projectId,
        admissionId: `${prefix}-source-probe`,
        requestId: `${prefix}-source-probe-request`,
        provider: "openai",
        model: "gpt-4o-mini",
        scope: { group: `${prefix}-call` },
        now: new Date(),
      },
    );
    assert.equal(observedAttempt.some((item) => item.observationId === attemptedChargeId), false, "admitted charge key must not be counted again through explicit usage");
    await pool.query("DELETE FROM events WHERE project_id = $1 AND id LIKE $2", [fixture.projectId, `${prefix}%`]);
    await pool.query("DELETE FROM usage_components WHERE project_id = $1 AND id = $2", [fixture.projectId, attemptedUsageId]);

    const settled = await request(started.url, "/api/v1/sdk/policy/settle", {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.authKey}` },
      body: JSON.stringify({
        projectId: fixture.projectId,
        reservationId: admission.body.reservationId,
        settlementId: `${prefix}-settlement`,
        outcome: "success",
        providerAttempted: true,
        actualCostUsd: 0.00001,
        actualUsage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      }),
    });
    assert.equal(settled.status, 200);
    assert.equal(settled.body.reservation.state, "settled");

    // This route regressed to 401 when a global session guard mounted before
    // the DSN compatibility router. Keep the compatibility proof in the app
    // test so startup ordering remains observable.
    const legacy = await request(started.url, "/api/v1/sdk/budget/rules", {
      headers: { Authorization: `Bearer ${fixture.authKey}` },
    });
    assert.equal(legacy.status, 200);
    assert.ok(Array.isArray(legacy.body.rules));
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime?.stopSchedulers();
    if (previousAcceptanceBase === undefined) delete process.env["ACCEPTANCE_BASE_URL"];
    else process.env["ACCEPTANCE_BASE_URL"] = previousAcceptanceBase;
    if (previousAcceptanceDatabase === undefined) delete process.env["ACCEPTANCE_DATABASE_URL"];
    else process.env["ACCEPTANCE_DATABASE_URL"] = previousAcceptanceDatabase;
    if (fixture) {
      // Remove only this test's durable identities. The policies are archived
      // through the public route below when possible, then deleted here so a
      // repeated local acceptance run does not accumulate reservations.
      await pool.query("DELETE FROM policy_decisions WHERE project_id = $1 AND admission_id LIKE $2", [fixture.projectId, `${prefix}%`]);
      await pool.query("DELETE FROM policy_reservations WHERE project_id = $1 AND admission_id LIKE $2", [fixture.projectId, `${prefix}%`]);
      await pool.query("DELETE FROM usage_components WHERE project_id = $1 AND id LIKE $2", [fixture.projectId, `${prefix}%`]);
      await pool.query("DELETE FROM events WHERE project_id = $1 AND id LIKE $2", [fixture.projectId, `${prefix}%`]);
      await pool.query("DELETE FROM notification_deliveries WHERE org_id = $1 AND destination_id IN (SELECT id FROM notification_destinations WHERE org_id = $1 AND id LIKE $2)", [fixture.orgId, `${prefix}%`]);
      await pool.query("DELETE FROM notification_destinations WHERE org_id = $1 AND id LIKE $2", [fixture.orgId, `${prefix}%`]);
      if (policyIds.length > 0) await pool.query(
        `DELETE FROM findings
         WHERE project_id = $1 AND family = 'allowance_trajectory'
           AND scope->>'value' = ANY($2::text[])`,
        [fixture.projectId, policyIds],
      );
      if (policyIds.length > 0) await pool.query("DELETE FROM spending_policies WHERE project_id = $1 AND id = ANY($2::text[])", [fixture.projectId, policyIds]);
      if (previousWorkspace) {
        await pool.query(
          `UPDATE workspace_settings
           SET timezone = $1, reporting_currency = $2, fx_rate = $3,
               fx_source = $4, fx_as_of = $5, updated_by = $6, updated_at = NOW()
           WHERE org_id = $7`,
          [previousWorkspace.timezone, previousWorkspace.reporting_currency, previousWorkspace.fx_rate,
            previousWorkspace.fx_source, previousWorkspace.fx_as_of, previousWorkspace.updated_by, fixture.orgId],
        );
      } else {
        await pool.query("DELETE FROM workspace_settings WHERE org_id = $1", [fixture.orgId]);
      }
    }
    await pool.end();
  }
});
