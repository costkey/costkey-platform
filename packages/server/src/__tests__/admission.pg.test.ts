import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import pg from "pg";
import {
  createSdkAdmissionRouter,
  PostgresPolicyAdmissionService,
  StaticProviderCapabilityRegistry,
  type PricingQuote,
} from "../admission.js";
import { ensurePolicySchema } from "../policy-storage.js";
import { SettlementConflictError } from "../reservation.js";

/**
 * Opt-in integration proof for the actual Pg adapter. It creates one random
 * schema on the local acceptance database, never touches public tables, and
 * drops only that schema in teardown. Set COSTKEY_PG_TEST_URL to run it.
 */
const connectionString = process.env["COSTKEY_PG_TEST_URL"];
const canRun = Boolean(connectionString);
const schemaName = `costkey_admission_${process.pid}_${Math.random().toString(16).slice(2)}`;
const projectId = "pg-project";
const now = new Date("2026-09-13T16:30:00.000Z");
const integration = {
  supported: true,
  admissionSupported: true,
  capabilityVersion: "pg-test/1",
  verified: true,
};
const quote: PricingQuote = {
  currency: "USD",
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 1,
  basis: "pg-test-catalog",
};

function pool(): pg.Pool {
  if (!connectionString) throw new Error("COSTKEY_PG_TEST_URL is required");
  return new pg.Pool({
    connectionString,
    max: 4,
    options: `-c search_path=${schemaName}`,
  });
}

function request(admissionId: string, overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    admissionId,
    requestId: `request-${admissionId}`,
    provider: "pg-test",
    model: "pg-model",
    integration,
    scope: { group: "parallel" },
    now,
    ...overrides,
  };
}

let setupClient: pg.Client | null = null;
let pools: pg.Pool[] = [];
let routeServers: Server[] = [];

before(async () => {
  if (!canRun) return;
  setupClient = new pg.Client({ connectionString });
  await setupClient.connect();
  await setupClient.query(`CREATE SCHEMA ${schemaName}`);
  await setupClient.query(`
    CREATE TABLE ${schemaName}.projects (
      id TEXT PRIMARY KEY,
      auth_key TEXT NOT NULL UNIQUE
    );
  `);
  const setupPool = pool();
  pools.push(setupPool);
  await ensurePolicySchema(setupPool);
  await ensurePolicySchema(setupPool);
  await setupPool.query(`INSERT INTO projects (id, auth_key) VALUES ($1, $2)`, [projectId, "pg-test-secret"]);
  await setupPool.query(
    `INSERT INTO spending_policies (id, project_id, name, scope, mode, status, unit, allowance, currency, window_kind, timezone)
     VALUES
       ('pg-shared-a',$1,'pg-shared-a','{"group":"parallel"}','enforce','active','calls',3,NULL,'calendar_day','UTC'),
       ('pg-shared-b',$1,'pg-shared-b','{"group":"parallel"}','enforce','active','calls',3,NULL,'calendar_day','UTC'),
       ('pg-duplicate-a',$1,'pg-duplicate-a','{"group":"duplicate"}','enforce','active','calls',1,NULL,'calendar_day','UTC'),
       ('pg-duplicate-b',$1,'pg-duplicate-b','{"group":"duplicate"}','enforce','active','calls',1,NULL,'calendar_day','UTC'),
       ('pg-late',$1,'pg-late','{"group":"late"}','enforce','active','calls',1,NULL,'calendar_day','UTC'),
       ('pg-unknown',$1,'pg-unknown','{"group":"unknown"}','enforce','active','calls',1,NULL,'calendar_day','UTC'),
       ('pg-revision',$1,'pg-revision','{"group":"revision"}','enforce','active','calls',3,NULL,'calendar_day','UTC'),
       ('pg-float',$1,'pg-float','{"group":"float"}','enforce','active','money',1,'USD','calendar_day','UTC')`,
    [projectId],
  );
});

after(async () => {
  for (const server of routeServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  routeServers = [];
  for (const candidate of pools) await candidate.end();
  pools = [];
  if (setupClient) {
    await setupClient.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await setupClient.end();
    setupClient = null;
  }
});

function services(): [PostgresPolicyAdmissionService, PostgresPolicyAdmissionService] {
  const firstPool = pool();
  const secondPool = pool();
  pools.push(firstPool, secondPool);
  const options = {
    pricing: () => quote,
    observedUsage: async () => [],
    clock: () => now,
    capabilities: new StaticProviderCapabilityRegistry([{ provider: "pg-test", capabilityVersion: "pg-test-server/1" }]),
  };
  return [new PostgresPolicyAdmissionService(firstPool, options), new PostgresPolicyAdmissionService(secondPool, options)];
}

async function startRoute(poolForRoute: pg.Pool, serviceForRoute: PostgresPolicyAdmissionService): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createSdkAdmissionRouter(poolForRoute, { service: serviceForRoute }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  routeServers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("route server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function postAdmission(url: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/api/v1/sdk/policy/admit`, {
    method: "POST",
    headers: { Authorization: "Bearer pg-test-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("PostgresReservationStore (opt-in local acceptance DB)", () => {
  it("rejects a caller capability claim for an unregistered provider", { skip: !canRun }, async () => {
    const [service] = services();
    const decision = await service.admit(request("pg-unknown-provider", {
      requestId: "pg-request-unknown-provider",
      provider: "unregistered-provider",
      scope: { group: "unknown" },
      integration: { supported: true, admissionSupported: true, verified: true, capabilityVersion: "attacker/1" },
    }));
    assert.equal(decision.decision, "refuse");
    if (decision.decision === "refuse") assert.equal(decision.reason, "unsupported_integration");
  });

  it("proves shared multi-policy atomicity and duplicate admission replay", { skip: !canRun }, async () => {
    const [left, right] = services();
    const [leftUrl, rightUrl] = await Promise.all([startRoute(pools[0], left), startRoute(pools[1], right)]);
    const parallel = await Promise.all([
      postAdmission(leftUrl, request("pg-parallel-1")),
      postAdmission(rightUrl, request("pg-parallel-2")),
      postAdmission(leftUrl, request("pg-parallel-3")),
      postAdmission(rightUrl, request("pg-parallel-4")),
    ]);
    assert.equal(parallel.filter((item) => item.body.decision === "allow").length, 3);
    assert.equal(parallel.filter((item) => item.body.decision === "refuse").length, 1);
    const duplicate = await Promise.all([
      postAdmission(leftUrl, request("pg-duplicate", { requestId: "pg-request-duplicate", scope: { group: "duplicate" } })),
      postAdmission(rightUrl, request("pg-duplicate", { requestId: "pg-request-duplicate", scope: { group: "duplicate" } })),
    ]);
    assert.equal(duplicate.filter((item) => item.status === 200 && item.body.decision === "allow").length, 2);
    assert.equal(duplicate.filter((item) => item.body.decision === "allow" && item.body.replay).length, 1);
    assert.equal(duplicate.filter((item) => item.body.decision === "allow" && item.body.providerCallAllowed).length, 1);
  });

  it("persists provisional unknown state, reconciles after a new pool, and rejects conflicting settlement reuse", { skip: !canRun }, async () => {
    const [first] = services();
    const admitted = await first.admit(request("pg-late", { requestId: "pg-request-late", scope: { group: "late" } }));
    if (admitted.decision !== "allow" || !admitted.reservationId) throw new Error("expected reservation");
    const unknown = await first.settle({ projectId, reservationId: admitted.reservationId, settlementId: "pg-provisional", outcome: "unknown", now });
    assert.equal(unknown.reservation.state, "unknown");

    const restartedPool = pool();
    pools.push(restartedPool);
    const restarted = new PostgresPolicyAdmissionService(restartedPool, {
      pricing: () => quote,
      observedUsage: async () => [],
      clock: () => now,
      capabilities: new StaticProviderCapabilityRegistry([{ provider: "pg-test", capabilityVersion: "pg-test-server/1" }]),
    });
    const final = await restarted.settle({
      projectId,
      reservationId: admitted.reservationId,
      settlementId: "pg-final",
      outcome: "success",
      actualUsage: { totalTokens: 0 },
      providerAttempted: true,
      actualCostUsd: 0,
      providerAttestation: { source: "server", actualCostUsd: 0, actualUsage: { totalTokens: 0 } },
      now,
    });
    assert.equal(final.reservation.state, "settled");
    await assert.rejects(
      restarted.settle({
        projectId,
        reservationId: admitted.reservationId,
        settlementId: "pg-final",
        outcome: "success",
        actualUsage: { totalTokens: 1 },
        providerAttempted: true,
        actualCostUsd: 0.1,
        providerAttestation: { source: "server", actualCostUsd: 0.1, actualUsage: { totalTokens: 1 } },
        now,
      }),
      SettlementConflictError,
    );
  });

  it("carries usage across a prospective limit revision", { skip: !canRun }, async () => {
    // The policy rows are independent of the admission service's catalog. A
    // direct store-level reservation makes the limit carry assertion explicit.
    const directPool = pool();
    pools.push(directPool);
    const { PostgresReservationStore } = await import("../reservation.js");
    const store = new PostgresReservationStore(directPool);
    await store.reserve({ projectId, admissionId: "pg-limit-old", fingerprint: "old", lines: [{ policyId: "pg-revision", windowKey: "2026-09-13", unit: "calls", quantity: 1, limit: 2 }], now });
    const edited = await store.reserve({ projectId, admissionId: "pg-limit-new", fingerprint: "new", lines: [{ policyId: "pg-revision", windowKey: "2026-09-13", unit: "calls", quantity: 1, limit: 3 }], now });
    assert.equal(edited.replay, false);
    await assert.rejects(store.reserve({ projectId, admissionId: "pg-limit-over", fingerprint: "over", lines: [{ policyId: "pg-revision", windowKey: "2026-09-13", unit: "calls", quantity: 1, limit: 2 }], now }), /not available/);
  });

  it("clamps sub-cent floating-point release residues before the non-negative check", { skip: !canRun }, async () => {
    const directPool = pool();
    pools.push(directPool);
    const { PostgresReservationStore } = await import("../reservation.js");
    const store = new PostgresReservationStore(directPool);
    const first = await store.reserve({ projectId, admissionId: "pg-float-a", fingerprint: "float-a", lines: [{ policyId: "pg-float", windowKey: "2026-09-13", unit: "money", currency: "USD", quantity: 0.1, limit: 1 }], now });
    const second = await store.reserve({ projectId, admissionId: "pg-float-b", fingerprint: "float-b", lines: [{ policyId: "pg-float", windowKey: "2026-09-13", unit: "money", currency: "USD", quantity: 0.2, limit: 1 }], now });
    await store.settle({ projectId, reservationId: first.reservation.reservationId, settlementId: "pg-float-settle-a", outcome: "success", actualLines: [{ policyId: "pg-float", quantity: 0.1 }], now });
    await store.settle({ projectId, reservationId: second.reservation.reservationId, settlementId: "pg-float-settle-b", outcome: "success", actualLines: [{ policyId: "pg-float", quantity: 0.2 }], now });
    const usage = await directPool.query<{ reserved_quantity: number }>("SELECT reserved_quantity FROM policy_window_usage WHERE policy_id = $1 AND window_key = $2", ["pg-float", "2026-09-13"]);
    assert.equal(Number(usage.rows[0]?.reserved_quantity), 0);
  });

  it("records unknown observed usage without counting it as zero, then applies a later price correction once", { skip: !canRun }, async () => {
    const directPool = pool();
    pools.push(directPool);
    const { PostgresReservationStore } = await import("../reservation.js");
    const store = new PostgresReservationStore(directPool);
    const base = { observationId: "pg-observed-correction", policyId: "pg-float", windowKey: "2026-09-13", unit: "money" as const, currency: "USD" as const, limit: 1, occurredAt: now };
    assert.equal((await store.recordObserved({ ...base, quantity: null, unknown: true })).recorded, true);
    assert.equal((await store.recordObserved({ ...base, quantity: null, unknown: true })).recorded, false);
    assert.equal((await store.recordObserved({ ...base, quantity: 0.4, unknown: false })).recorded, true);
    const usage = await directPool.query<{ observed_quantity: number; unknown_observations: number }>("SELECT observed_quantity, unknown_observations FROM policy_window_usage WHERE policy_id = $1 AND window_key = $2", ["pg-float", "2026-09-13"]);
    assert.equal(Number(usage.rows[0]?.observed_quantity), 0.4);
    assert.equal(Number(usage.rows[0]?.unknown_observations), 0);
  });
});
