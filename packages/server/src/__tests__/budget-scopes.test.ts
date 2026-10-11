import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import {
  PolicyAdmissionService,
  StaticPolicyCatalog,
  StaticProviderCapabilityRegistry,
  createSdkAdmissionRouter,
  isIdentityWindow,
  normalizeSpendingPolicy,
  policyScopeClauses,
  policyWindowKey,
  type PricingQuote,
  type SpendingPolicy,
} from "../admission.js";
import { sanitizePolicy } from "../budgets.js";
import { InMemoryReservationStore } from "../reservation.js";

const NOW = new Date("2026-10-10T09:30:00.000Z");
const quote: PricingQuote = { currency: "USD", inputUsdPerMillion: 1, outputUsdPerMillion: 1, basis: "test-catalog" };

function policy(overrides: Partial<SpendingPolicy> = {}): SpendingPolicy {
  return {
    id: "policy",
    projectId: "project-1",
    name: "test",
    scope: {},
    mode: "enforce",
    status: "active",
    unit: "calls",
    allowance: 10,
    window: "calendar_day",
    timezone: "UTC",
    periodStart: "calendar",
    ...overrides,
  };
}

function service(policies: SpendingPolicy[]): PolicyAdmissionService {
  return new PolicyAdmissionService({
    catalog: new StaticPolicyCatalog(policies),
    store: new InMemoryReservationStore(),
    pricing: () => quote,
    clock: () => NOW,
    capabilities: new StaticProviderCapabilityRegistry([{ provider: "test-provider", capabilityVersion: "test-server/1" }]),
  });
}

function request(admissionId: string, overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1",
    admissionId,
    requestId: `provider-${admissionId}`,
    provider: "test-provider",
    model: "test-model",
    now: NOW,
    ...overrides,
  };
}

describe("scope parsing", () => {
  it("normalizes groups, keeps a single value as a string, and reads user aliases", () => {
    const group = normalizeSpendingPolicy({ id: "a", project_id: "p", scope: { feature: [" search", "answer", "search", " "] }, unit: "calls", allowance: 1 });
    assert.deepEqual(group.scope.feature, ["search", "answer"]);
    const single = normalizeSpendingPolicy({ id: "b", project_id: "p", scope: { feature: ["only"] }, unit: "calls", allowance: 1 });
    assert.equal(single.scope.feature, "only");
    const user = normalizeSpendingPolicy({ id: "c", project_id: "p", scope: JSON.stringify({ userId: "u-1" }), unit: "calls", allowance: 1 });
    assert.equal(user.scope.user, "u-1");
    const legacy = normalizeSpendingPolicy({ id: "d", project_id: "p", scope_user: "u-2", unit: "calls", allowance: 1 });
    assert.equal(legacy.scope.user, "u-2");
  });

  it("validates group size and value length, and keeps agent/tool/user dimensions", () => {
    const parsed = sanitizePolicy({ unit: "calls", allowance: 5, scope: { feature: ["search", "answer", "rerank"] } });
    assert.ok(!("error" in parsed));
    if (!("error" in parsed)) assert.deepEqual(parsed.scope, { feature: ["search", "answer", "rerank"] });
    const single = sanitizePolicy({ unit: "calls", allowance: 5, scope: { feature: "search" } });
    if (!("error" in single)) assert.deepEqual(single.scope, { feature: "search" });
    for (const key of ["agent", "tool", "user", "workflow"]) {
      const kept = sanitizePolicy({ unit: "calls", allowance: 5, scope: { [key]: "x" } });
      assert.ok(!("error" in kept));
      if (!("error" in kept)) assert.deepEqual(kept.scope, { [key]: "x" });
    }
    const tooMany = sanitizePolicy({ unit: "calls", allowance: 5, scope: { feature: Array.from({ length: 51 }, (_, index) => `f${index}`) } });
    assert.ok("error" in tooMany);
    const tooLong = sanitizePolicy({ unit: "calls", allowance: 5, scope: { feature: ["ok", "x".repeat(201)] } });
    assert.ok("error" in tooLong);
    const notStrings = sanitizePolicy({ unit: "calls", allowance: 5, scope: { feature: ["ok", 3] } });
    assert.ok("error" in notStrings);
  });

  it("builds = ANY filters for groups and LIKE filters for single values", () => {
    const params: unknown[] = ["project-1"];
    const clauses = policyScopeClauses({ feature: ["search", "answer"], model: "gpt-*", user: "u-1", function: ["a.ts:run", "run"] }, params, "c");
    assert.ok(clauses.includes("COALESCE(c.context->>'feature', '') = ANY($2::text[])"));
    assert.ok(clauses.some((clause) => clause.includes("COALESCE(c.bl_function, '') = ANY($3::text[])")));
    assert.ok(clauses.includes("COALESCE(c.model, '') LIKE $4 ESCAPE '\\'"));
    assert.ok(clauses.includes("COALESCE(c.context->>'userId', c.context->>'user_id', '') LIKE $5 ESCAPE '\\'"));
    assert.deepEqual(params, ["project-1", ["search", "answer"], ["a.ts:run", "run"], "gpt-%", "u-1"]);
    const workflowParams: unknown[] = [];
    assert.deepEqual(policyScopeClauses({ workflow: ["import", "export"] }, workflowParams), [
      "COALESCE(trace_name, context->>'traceName', context->>'trace_name', '') = ANY($1::text[])",
    ]);
  });
});

describe("group and user admission", () => {
  it("pools every group member into one allowance and ignores non-members", async () => {
    const admission = service([policy({ id: "group", allowance: 2, scope: { feature: ["search", "answer", "rerank"] } })]);
    const first = await admission.admit(request("g1", { context: { feature: "search" } }));
    const second = await admission.admit(request("g2", { context: { feature: "answer" } }));
    const third = await admission.admit(request("g3", { context: { feature: "rerank" } }));
    assert.equal(first.decision, "allow");
    assert.equal(second.decision, "allow");
    assert.equal(third.decision, "refuse");
    if (third.decision === "refuse") assert.equal(third.reason, "budget_exhausted");
    const outside = await admission.admit(request("g4", { context: { feature: "searchy" } }));
    assert.equal(outside.decision, "allow");
    if (outside.decision === "allow") assert.equal(outside.enforcementApplied, false);
    const missing = await admission.admit(request("g5"));
    assert.equal(missing.decision, "refuse");
    if (missing.decision === "refuse") assert.equal(missing.reason, "missing_context");
  });

  it("matches a user budget on userId or user_id", async () => {
    const admission = service([policy({ id: "user", allowance: 1, scope: { user: "u-1" } })]);
    const camel = await admission.admit(request("u1", { context: { userId: "u-1" } }));
    assert.equal(camel.decision, "allow");
    if (camel.decision === "allow") assert.equal(camel.enforcementApplied, true);
    const snake = await admission.admit(request("u2", { context: { user_id: "u-1" } }));
    assert.equal(snake.decision, "refuse");
    const other = await admission.admit(request("u3", { context: { userId: "u-2" } }));
    assert.equal(other.decision, "allow");
    if (other.decision === "allow") assert.equal(other.enforcementApplied, false);
  });
});

describe("workflow admission", () => {
  it("matches a workflow group on the trace name from context", async () => {
    const admission = service([policy({ id: "workflow", allowance: 1, scope: { workflow: ["nightly-import", "nightly-export"] } })]);
    const named = await admission.admit(request("w1", { context: { traceName: "nightly-export" } }));
    assert.equal(named.decision, "allow");
    if (named.decision === "allow") assert.equal(named.enforcementApplied, true);
    const snake = await admission.admit(request("w2", { context: { trace_name: "nightly-import" } }));
    assert.equal(snake.decision, "refuse");
    const other = await admission.admit(request("w3", { context: { traceName: "chat" } }));
    assert.equal(other.decision, "allow");
    if (other.decision === "allow") assert.equal(other.enforcementApplied, false);
  });
});

describe("per-call budgets", () => {
  it("has no shared window and rejects a per-call call count", () => {
    assert.equal(isIdentityWindow("per_call"), true);
    assert.throws(() => policyWindowKey({ window: "per_call", timezone: "UTC" }, NOW));
    assert.equal(normalizeSpendingPolicy({ id: "x", project_id: "p", unit: "calls", allowance: 1, window_kind: "per_call" }).valid, false);
    assert.equal(normalizeSpendingPolicy({ id: "x", project_id: "p", unit: "money", allowance: 1, currency: "USD", window_kind: "per_call" }).window, "per_call");
    const parsed = sanitizePolicy({ unit: "money", allowance: 0.5, window: "per_call", scope: { model: "gpt-4o" } });
    assert.ok(!("error" in parsed));
    if (!("error" in parsed)) assert.equal(parsed.window_kind, "per_call");
    assert.ok("error" in sanitizePolicy({ unit: "calls", allowance: 1, window: "per_call" }));
  });

  it("refuses only a call whose worst-case cost exceeds the cap, without accumulating", async () => {
    const admission = service([policy({ id: "per-call", unit: "money", currency: "USD", allowance: 0.005, window: "per_call", scope: { model: "test-model" } })]);
    for (const id of ["c1", "c2", "c3"]) {
      const allowed = await admission.admit(request(id, { usageBounds: { maxInputTokens: 1000, maxOutputTokens: 1000 } }));
      assert.equal(allowed.decision, "allow");
      if (allowed.decision === "allow") {
        assert.equal(allowed.enforcementApplied, true);
        assert.equal(allowed.reservationId, null);
        assert.equal(allowed.policies[0]?.quantity, 0.002);
      }
    }
    const refused = await admission.admit(request("c4", { usageBounds: { maxInputTokens: 4000, maxOutputTokens: 2000 } }));
    assert.equal(refused.decision, "refuse");
    if (refused.decision === "refuse") {
      assert.equal(refused.reason, "call_too_expensive");
      assert.equal(refused.window, "per_call");
      assert.equal(refused.retryAt, null);
      assert.equal(refused.policyId, "per-call");
    }
    const otherModel = await admission.admit(request("c5", { model: "other-model", usageBounds: { maxInputTokens: 9000, maxOutputTokens: 9000 } }));
    assert.equal(otherModel.decision, "allow");
  });

  it("caps tokens per call and monitors without refusing", async () => {
    const tokens = service([policy({ id: "tokens", unit: "tokens", allowance: 1500, window: "per_call" })]);
    const refused = await tokens.admit(request("t1", { usageBounds: { maxInputTokens: 1000, maxOutputTokens: 1000 } }));
    assert.equal(refused.decision, "refuse");
    if (refused.decision === "refuse") assert.equal(refused.reason, "call_too_expensive");
    const monitor = service([policy({ id: "monitor", unit: "tokens", allowance: 1, window: "per_call", mode: "monitor" })]);
    const allowed = await monitor.admit(request("t2", { usageBounds: { maxInputTokens: 1000, maxOutputTokens: 1000 } }));
    assert.equal(allowed.decision, "allow");
  });

  it("returns 429 with the call_too_expensive reason over HTTP", async () => {
    const fakePool = {
      query: async (sql: string) => sql.includes("projects") ? { rows: [{ id: "project-1" }] } : { rows: [] },
    } as unknown as import("pg").Pool;
    const app = express();
    app.use(express.json());
    app.use(createSdkAdmissionRouter(fakePool, { service: service([policy({ unit: "money", currency: "USD", allowance: 0.001, window: "per_call" })]) }));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/sdk/policy/admit`, {
        method: "POST",
        headers: { Authorization: "Bearer project-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ admissionId: "http-per-call", provider: "test-provider", model: "test-model", usageBounds: { maxInputTokens: 5000, maxOutputTokens: 5000 } }),
      });
      const body = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 429);
      assert.equal(body.reason, "call_too_expensive");
      assert.equal(response.headers.get("retry-after"), null);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
