import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  ACCEPTANCE_PASSWORD,
  ACCEPTANCE_ORG_ID,
  CROSS_SDK_TRACE_ID,
  CROSS_SDK_TRACE_NAME,
  ROLE_USER_IDS,
  seedAcceptanceFixtures,
  type AcceptanceFixture,
  type AcceptanceRole,
} from "./fixtures.js";
import {
  ACCEPTANCE_SCENARIOS,
  ALL_CATALOG_IDS,
  CAPABILITIES,
  FAILURE_PATHS,
  type ProofLevel,
} from "./catalog.js";
import { expectStatus, HttpClient, jsonBody, safeBody, type HttpResult } from "./http.js";
import { CostKey } from "../../packages/sdk/src/index.js";

const { Pool } = pg;

type LocalOutcome = "pass" | "fail" | "not-implemented" | "blocked" | "not-run" | "smoke-only";

type CheckKind = "substantive" | "smoke";

interface CheckRecord {
  label: string;
  outcome: Exclude<LocalOutcome, "not-run">;
  proof: ProofLevel;
  kind: CheckKind;
  detail: string;
  observedAt: string;
}

interface EvidenceRecord {
  id: string;
  title: string;
  contract: string;
  requiredProof: ProofLevel[];
  status: "INCOMPLETE";
  localOutcome: LocalOutcome;
  localVerification: "NOT_VERIFIED" | "LOCAL_VERIFIED" | "SMOKE_ONLY";
  checks: CheckRecord[];
}

interface EnvironmentEvidence {
  baseUrl: string;
  databaseHost: string;
  databaseName: string;
  externalDelivery: "disabled";
  networkGuard: "loopback-only";
  providerNetwork: "not-used";
  fixtureBoundary: "synthetic-local-only";
}

interface EvidenceReport {
  schemaVersion: 1;
  generatedAt: string;
  proofBoundary: string;
  environment: EnvironmentEvidence;
  summary: Record<LocalOutcome | "incomplete", number>;
  capabilities: EvidenceRecord[];
  acceptanceScenarios: EvidenceRecord[];
  failurePaths: typeof FAILURE_PATHS;
}

interface LocalConfig {
  baseUrl: string;
  databaseUrl: string;
  reportPath: string;
  strict: boolean;
}

interface RoleClients {
  owner: HttpClient;
  admin: HttpClient;
  developer: HttpClient;
  viewer: HttpClient;
}

interface LocalNotificationApi {
  clearLocalNotificationSink(): void;
  getLocalNotificationSink(): ReadonlyArray<{ url: string; headers: Record<string, string>; body: string }>;
  runWeeklyDigests(pool: pg.Pool, now?: Date): Promise<number>;
  verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string, maxAgeSeconds?: number): boolean;
}

let localNotificationApi: LocalNotificationApi | null = null;

interface LocalHistoricalApi {
  reconcileDailyCostAggregates(pool: pg.Pool, projectId: string, day: string): Promise<number>;
  runRetention(pool: pg.Pool, now?: Date, orgId?: string): Promise<{ deletedEvents: number; blockedProjects?: string[] }>;
}

let localHistoricalApi: LocalHistoricalApi | null = null;

async function loadLocalNotificationApi(): Promise<LocalNotificationApi> {
  if (!localNotificationApi) {
    const moduleUrl = pathToFileURL(path.resolve("packages/server/src/notifications.ts")).href;
    const imported = await import(moduleUrl) as Partial<LocalNotificationApi>;
    if (typeof imported.clearLocalNotificationSink !== "function"
      || typeof imported.getLocalNotificationSink !== "function"
      || typeof imported.runWeeklyDigests !== "function"
      || typeof imported.verifyWebhookSignature !== "function") {
      throw new Error("local notification module does not expose the required sink/digest functions");
    }
    localNotificationApi = imported as LocalNotificationApi;
  }
  return localNotificationApi;
}

async function loadLocalHistoricalApi(): Promise<LocalHistoricalApi> {
  if (!localHistoricalApi) {
    const accountingUrl = pathToFileURL(path.resolve("packages/server/src/accounting.ts")).href;
    const retentionUrl = pathToFileURL(path.resolve("packages/server/src/retention.ts")).href;
    const [accounting, retention] = await Promise.all([import(accountingUrl), import(retentionUrl)]);
    const imported = {
      reconcileDailyCostAggregates: accounting.reconcileDailyCostAggregates,
      runRetention: retention.runRetention,
    } as Partial<LocalHistoricalApi>;
    if (typeof imported.reconcileDailyCostAggregates !== "function" || typeof imported.runRetention !== "function") {
      throw new Error("local accounting/retention modules do not expose historical aggregate functions");
    }
    localHistoricalApi = imported as LocalHistoricalApi;
  }
  return localHistoricalApi;
}

class EvidenceLedger {
  private readonly records = new Map<string, EvidenceRecord>();

  constructor() {
    for (const item of [...CAPABILITIES, ...ACCEPTANCE_SCENARIOS]) {
      this.records.set(item.id, {
        id: item.id,
        title: item.title,
        contract: "contract" in item ? item.contract : item.requiredResult,
        requiredProof: "proof" in item ? item.proof : ["real-provider", "deployed"],
        status: "INCOMPLETE",
        localOutcome: "not-run",
        localVerification: "NOT_VERIFIED",
        checks: [],
      });
    }
  }

  addCheck(
    ids: readonly string[],
    label: string,
    outcome: Exclude<LocalOutcome, "not-run">,
    proof: ProofLevel,
    detail: string,
    kind: CheckKind = "substantive",
  ): void {
    const check: CheckRecord = {
      label,
      outcome,
      proof,
      kind,
      detail: detail.slice(0, 1_000),
      observedAt: new Date().toISOString(),
    };
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record) throw new Error(`Unknown acceptance catalog ID: ${id}`);
      record.checks.push(check);
      record.localOutcome = this.deriveOutcome(record.checks);
      record.localVerification = this.deriveVerification(record);
    }
  }

  recordCheck(
    ids: readonly string[],
    label: string,
    proof: ProofLevel,
    operation: () => Promise<string | void>,
  ): Promise<void> {
    return operation()
      .then((detail) => {
        this.addCheck(ids, label, "pass", proof, typeof detail === "string" ? detail : "assertions passed");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.addCheck(ids, label, "fail", proof, message);
      });
  }

  recordNotImplemented(ids: readonly string[], label: string, detail: string): void {
    this.addCheck(ids, label, "not-implemented", "local-http", detail);
  }

  recordBlocked(ids: readonly string[], label: string, detail: string): void {
    this.addCheck(ids, label, "blocked", "local-http", detail);
  }

  get(id: string): EvidenceRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown acceptance catalog ID: ${id}`);
    return record;
  }

  values(): EvidenceRecord[] {
    for (const record of this.records.values()) {
      if (record.checks.length === 0) {
        record.localOutcome = "not-run";
        record.localVerification = "NOT_VERIFIED";
      }
    }
    return Array.from(this.records.values());
  }

  private deriveOutcome(checks: CheckRecord[]): Exclude<LocalOutcome, "not-run"> {
    const substantive = checks.filter((check) => check.kind === "substantive");
    if (substantive.length === 0) {
      if (checks.some((check) => check.outcome === "fail")) return "fail";
      if (checks.some((check) => check.outcome === "blocked")) return "blocked";
      if (checks.some((check) => check.outcome === "not-implemented")) return "not-implemented";
      return "smoke-only";
    }
    if (substantive.some((check) => check.outcome === "fail")) return "fail";
    if (substantive.some((check) => check.outcome === "blocked")) return "blocked";
    if (substantive.some((check) => check.outcome === "not-implemented")) return "not-implemented";
    return "pass";
  }

  private deriveVerification(record: EvidenceRecord): EvidenceRecord["localVerification"] {
    if (record.localOutcome === "pass") return "LOCAL_VERIFIED";
    if (record.localOutcome === "smoke-only") return "SMOKE_ONLY";
    return "NOT_VERIFIED";
  }
}

function localConfig(): LocalConfig {
  const baseUrl = process.env["ACCEPTANCE_BASE_URL"] ?? "";
  const databaseUrl = process.env["ACCEPTANCE_DATABASE_URL"] ?? "";
  if (!baseUrl || !databaseUrl) {
    throw new Error(
      "Refusing to run without explicit ACCEPTANCE_BASE_URL and ACCEPTANCE_DATABASE_URL; use scripts/acceptance/run-local.sh",
    );
  }

  const base = new URL(baseUrl);
  if (base.protocol !== "http:" || !isLoopback(base.hostname)) {
    throw new Error(`Acceptance BASE_URL must be http://127.0.0.1 or http://localhost (received ${base.protocol}//${base.hostname})`);
  }

  const database = new URL(databaseUrl);
  if (!isLoopback(database.hostname)) {
    throw new Error("Acceptance database must use a loopback host; production DATABASE_URL is not allowed");
  }
  if (database.protocol !== "postgresql:" && database.protocol !== "postgres:") {
    throw new Error(`Acceptance database must be PostgreSQL (received ${database.protocol})`);
  }
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("Acceptance harness refuses NODE_ENV=production");
  }
  if (process.env["ACCEPTANCE_EXTERNAL_DELIVERY"] !== "disabled") {
    throw new Error("Acceptance harness requires ACCEPTANCE_EXTERNAL_DELIVERY=disabled");
  }
  if (process.env["COSTKEY_NOTIFICATION_SINK"] !== "memory") {
    throw new Error("Acceptance harness requires COSTKEY_NOTIFICATION_SINK=memory; external delivery is never used");
  }
  if (process.env["COSTKEY_NOTIFICATION_TEST_ALLOW_LOOPBACK"] !== "1") {
    throw new Error("Acceptance harness requires the explicit loopback notification sink opt-in");
  }
  if (!process.env["NODE_OPTIONS"]?.includes("network-deny.mjs")) {
    throw new Error("Acceptance harness requires the loopback-only network-deny preload");
  }
  if (process.env["DATABASE_URL"] && process.env["DATABASE_URL"] !== databaseUrl) {
    throw new Error("DATABASE_URL must exactly match the explicit local acceptance database URL");
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    databaseUrl,
    reportPath: path.resolve(
      process.env["ACCEPTANCE_REPORT"] ?? "docs/implementation/acceptance-evidence.local.json",
    ),
    strict: process.argv.includes("--strict"),
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function databaseEvidence(databaseUrl: string): Pick<EnvironmentEvidence, "databaseHost" | "databaseName"> {
  const database = new URL(databaseUrl);
  return {
    databaseHost: database.hostname,
    databaseName: database.pathname.replace(/^\//, "") || "unknown",
  };
}

async function waitForServer(baseUrl: string, pool: pg.Pool): Promise<void> {
  const health = new HttpClient(baseUrl);
  let lastError = "not attempted";
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await health.request("/health", { timeoutMs: 1_000 });
      const body = response.body as { status?: string } | string | null;
      if (response.status === 200 && typeof body === "object" && body?.status === "ok") {
        const tables = await pool.query<{ events: string | null; projects: string | null }>(
          "SELECT to_regclass('public.events') AS events, to_regclass('public.projects') AS projects",
        );
        if (tables.rows[0]?.events && tables.rows[0]?.projects) {
          // The API router is mounted after init/seed. An unauthenticated 401
          // confirms that route installation is complete without logging in.
          const api = await health.request("/api/v1/projects", { timeoutMs: 1_000 });
          if (api.status === 401 || api.status === 200) return;
          lastError = `health ready but project API returned ${api.status}`;
        }
      } else {
        lastError = `health returned ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for local CostKey server: ${lastError}`);
}

async function runNetworkBoundaryProbe(ledger: EvidenceLedger): Promise<void> {
  await ledger.recordCheck(
    ["F11"],
    "Loopback-only network guard",
    "local-http",
    async () => {
      let fetchBlocked = false;
      try {
        await fetch("https://example.com");
      } catch (error) {
        fetchBlocked = String(error).includes("network guard");
      }
      assert.equal(fetchBlocked, true, "non-loopback fetch must be blocked before network I/O");

      let httpsBlocked = false;
      try {
        https.request("https://example.com");
      } catch (error) {
        httpsBlocked = String(error).includes("network guard");
      }
      assert.equal(httpsBlocked, true, "non-loopback https.request must be blocked before network I/O");

      let socketBlocked = false;
      try {
        net.connect(443, "example.com");
      } catch (error) {
        socketBlocked = String(error).includes("network guard");
      }
      assert.equal(socketBlocked, true, "non-loopback net.connect must be blocked before network I/O");
      return "fetch, https.request, and net.connect all rejected non-loopback destinations synchronously";
    },
  );
}

async function impersonate(baseUrl: string, role: AcceptanceRole): Promise<HttpClient> {
  const client = new HttpClient(baseUrl);
  const email = `${role}@acceptance.invalid`;
  const response = await client.request("/auth/login", {
    method: "POST",
    body: { email, password: ACCEPTANCE_PASSWORD },
  });
  expectStatus(response, 200, `login ${role}`);
  const loginBody = apiBody(response, `login ${role}`);
  const token = loginBody["token"];
  assert.equal(typeof token, "string", `${role} login must return a bearer token`);
  client.setBearerToken(token as string);
  const me = await client.request("/auth/me");
  expectStatus(me, 200, `${role} auth/me`);
  const meBody = jsonBody<{ user?: { role?: string; orgId?: string } }>(me, `${role} auth/me`);
  assert.equal(meBody.user?.orgId, ACCEPTANCE_ORG_ID, `${role} must belong to acceptance org`);
  return client;
}

async function createRoleClients(baseUrl: string): Promise<RoleClients> {
  return {
    owner: await impersonate(baseUrl, "owner"),
    admin: await impersonate(baseUrl, "admin"),
    developer: await impersonate(baseUrl, "developer"),
    viewer: await impersonate(baseUrl, "viewer"),
  };
}

function apiBody(result: HttpResult<unknown>, label: string): Record<string, unknown> {
  return jsonBody<Record<string, unknown>>(result, label);
}

function containsBodyOrSource(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return [
    "request_body", "response_body", "requestBody", "responseBody",
    "system_prompt", "systemPrompt", "call_site_raw", "callSiteRaw",
    "call_site_frames", "callSiteFrames", "bl_file", "blFile", "bl_line", "blLine",
  ].some((key) => object[key] !== undefined && object[key] !== null);
}

function responseHasSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => responseHasSensitiveField(entry));
  return containsBodyOrSource(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function bodyContains(value: unknown, text: string): boolean {
  return JSON.stringify(value ?? null).includes(text);
}

function redactChildOutput(value: string): string {
  return value
    .replace(/https?:\/\/[^@\s/]+@/gi, "http://<redacted>@")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/\b(?:sk|ck)_[A-Za-z0-9_-]+\b/g, "<redacted-key>")
    .replace(/\beyJ[A-Za-z0-9._-]+\b/g, "<redacted-token>")
    .replace(/((?:password|secret|token|dsn|authorization|api[_-]?key)\s*[:=]\s*)[^,;\s}"']+/gi, "$1<redacted>");
}

async function runIngestAndTraceProbes(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  roles: RoleClients,
  baseUrl: string,
): Promise<void> {
  const ingestEvent = {
    id: fixture.eventIds.ingested,
    timestamp: new Date().toISOString(),
    projectId: "ignored-by-dsn",
    provider: "openai",
    model: "gpt-4o",
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST",
    statusCode: 200,
    usage: {
      inputTokens: 1_000,
      outputTokens: 500,
      totalTokens: 1_500,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    },
    costUsd: null,
    durationMs: 25,
    streaming: false,
    streamTiming: null,
    callSite: {
      raw: "at acceptance (src/acceptance.ts:1:1)",
      frames: [{ fileName: "src/acceptance.ts", functionName: "acceptance", lineNumber: 1, columnNumber: 1 }],
    },
    context: { traceId: "trace_acceptance_ingest", traceName: "acceptance-ingest", environment: "test" },
    requestBody: { messages: [{ role: "user", content: "local acceptance input" }] },
    responseBody: { choices: [{ message: { role: "assistant", content: "local acceptance output" } }] },
  };

  await ledger.recordCheck(
    ["F01", "DX01", "AC01"],
    "DSN ingest without labels",
    "local-http",
    async () => {
      const response = await new HttpClient(baseUrl).request(
        "/api/v1/events",
        {
          method: "POST",
          headers: { authorization: `Bearer ${fixture.projectKey}` },
          body: { sdkVersion: "acceptance-fixture", events: [ingestEvent] },
        },
      );
      expectStatus(response, 202, "DSN ingest");
      const duplicate = await new HttpClient(baseUrl).request("/api/v1/events", {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.projectKey}` },
        body: { sdkVersion: "acceptance-fixture", events: [ingestEvent] },
      });
      expectStatus(duplicate, 202, "duplicate DSN ingest");
      const count = await pool.query<{ count: string; cost: number | null }>(
        "SELECT COUNT(*)::text AS count, MAX(cost_usd) AS cost FROM events WHERE id = $1",
        [fixture.eventIds.ingested],
      );
      assert.equal(count.rows[0]?.count, "1", "duplicate envelope must persist one event");
      assert.ok(count.rows[0]?.cost != null, "known model/usage must be priced locally");
      return "202 accepted twice; one durable row; cost was resolved locally";
    },
  );

  await ledger.recordCheck(
    ["F01", "AC16"],
    "Rejected ingest is explicit",
    "local-http",
    async () => {
      const missingEvents = await new HttpClient(baseUrl).request("/api/v1/events", {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.projectKey}` },
        body: { sdkVersion: "acceptance-fixture" },
      });
      expectStatus(missingEvents, 400, "missing events payload");
      const invalidKey = await new HttpClient(baseUrl).request("/api/v1/events", {
        method: "POST",
        headers: { authorization: "Bearer ck_not-a-real-key" },
        body: { sdkVersion: "acceptance-fixture", events: [] },
      });
      expectStatus(invalidKey, 401, "invalid DSN");
      return "missing payload returned 400 and invalid DSN returned 401";
    },
  );

  await ledger.recordCheck(
    ["F02", "F03", "AC02", "AC03", "AC04", "AC05", "AC17"],
    "Trace/event inspection and reconciliation",
    "local-http",
    async () => {
      const list = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/events?limit=50`);
      expectStatus(list, 200, "event list");
      const eventBody = apiBody(list, "event list");
      const events = eventBody["events"];
      assert.ok(Array.isArray(events), "event list must expose events array");
      assert.ok((events as unknown[]).some((event) => (event as Record<string, unknown>)["id"] === fixture.eventIds.unpriced));

      const detail = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/events/${fixture.eventIds.known}`);
      expectStatus(detail, 200, "event detail");
      const detailBody = apiBody(detail, "event detail");
      const event = detailBody["event"] as Record<string, unknown> | undefined;
      assert.equal(JSON.stringify(event?.["request_body"]).includes(fixture.sensitiveMarker), true, "owner detail should preserve fixture body");

      const traces = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/traces`);
      expectStatus(traces, 200, "trace list");
      const traceListBody = apiBody(traces, "trace list");
      assert.ok(Array.isArray(traceListBody["traces"]), "trace list must expose traces array");

      const trace = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/traces/${fixture.traceId}`);
      expectStatus(trace, 200, "trace detail");
      const traceDetailBody = apiBody(trace, "trace detail");
      const traceEvents = traceDetailBody["events"];
      assert.ok(Array.isArray(traceEvents), "trace detail must expose member events");
      assert.ok(traceEvents.length >= 3, "fixture trace should include known, retry, and unpriced children");
      const traceSummary = traceDetailBody["summary"] as Record<string, unknown> | undefined;
      assert.ok(traceSummary && ("unpriced_count" in traceSummary || "unpricedCount" in traceSummary), "trace summary must expose unpriced child count");
      assert.ok(traceSummary && ("coverage" in traceSummary || "pricing_coverage" in traceSummary), "trace summary must expose priced coverage");

      const totals = await pool.query<{ known: number | null; count: string; unpriced: string }>(
        `SELECT SUM(cost_usd) AS known, COUNT(*)::text AS count,
                COUNT(*) FILTER (WHERE cost_usd IS NULL)::text AS unpriced
         FROM events WHERE project_id = $1 AND id IN ($2, $3, $4, $5)`,
        [fixture.projectId, fixture.eventIds.known, fixture.eventIds.retry, fixture.eventIds.unpriced, fixture.eventIds.ingested],
      );
      assert.equal(totals.rows[0]?.count, "4");
      assert.equal(totals.rows[0]?.unpriced, "1");
      assert.ok(Number(totals.rows[0]?.known) > 0);
      const listedKnownCost = traceEvents
        .filter((event) => [fixture.eventIds.known, fixture.eventIds.retry, fixture.eventIds.unpriced].includes(String((event as Record<string, unknown>)["id"])))
        .reduce((sum, event) => {
          const value = Number((event as Record<string, unknown>)["cost_usd"] ?? (event as Record<string, unknown>)["costUsd"]);
          return Number.isFinite(value) ? sum + value : sum;
        }, 0);
      assert.ok(Math.abs(listedKnownCost - Number(totals.rows[0]?.known ?? 0) + Number((await pool.query<{ cost: number | null }>("SELECT cost_usd AS cost FROM events WHERE id = $1", [fixture.eventIds.ingested])).rows[0]?.cost ?? 0)) < 1e-9, "trace known subtotal must reconcile to the same cohort");
      return `event list/detail and trace detail exposed ${traceEvents.length} fixture children; DB known cost remained partial with ${totals.rows[0]?.unpriced} unpriced child`;
    },
  );

  await ledger.recordCheck(
    ["F02", "F07", "F08", "F12", "DX07", "DX08", "AC02", "AC10", "AC11", "AC12", "AC15"],
    "Trace detail separates calls, lifecycle, and usage components",
    "local-http",
    async () => {
      const lifecycleResponse = await new HttpClient(baseUrl).request("/api/v1/events", {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.projectKey}` },
        body: {
          sdkVersion: "acceptance-trace-detail",
          events: [{
            id: "evt_acceptance_cross_lifecycle",
            timestamp: new Date().toISOString(),
            eventType: "lifecycle",
            entityType: "trace",
            entityId: CROSS_SDK_TRACE_ID,
            lifecycle: "started",
            sequence: 1,
            context: { traceId: CROSS_SDK_TRACE_ID, traceName: CROSS_SDK_TRACE_NAME, environment: "acceptance" },
            metadata: { source: "acceptance-lifecycle" },
          }],
        },
      });
      expectStatus(lifecycleResponse, 202, "trace lifecycle ingest");

      const ownerTrace = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/traces/${encodeURIComponent(CROSS_SDK_TRACE_ID)}`);
      expectStatus(ownerTrace, 200, "cross-SDK trace detail");
      const ownerBody = apiBody(ownerTrace, "cross-SDK trace detail");
      const calls = ownerBody["events"];
      const lifecycle = ownerBody["lifecycleEvents"];
      const usage = ownerBody["usageComponents"];
      assert.ok(Array.isArray(calls) && calls.length >= 1, "trace detail must expose automatic provider calls separately");
      assert.ok(Array.isArray(lifecycle) && lifecycle.some((event) => (event as Record<string, unknown>)["lifecycle_state"] === "started"), "trace detail must expose lifecycle events separately");
      assert.ok(Array.isArray(usage) && usage.length >= 1, "trace detail must expose explicit usage components separately");
      assert.ok((calls as Array<Record<string, unknown>>).every((event) => event["event_type"] === "call"), "events collection must contain calls only");
      assert.ok((usage as Array<Record<string, unknown>>).every((component) => component["component_id"] || component["componentId"]), "usage collection must preserve component identity");
      assert.equal((usage as Array<Record<string, unknown>>)[0]?.["aggregation"], "cumulative", "trace detail must expose the active cumulative usage revision");
      assert.equal(Number((usage as Array<Record<string, unknown>>)[0]?.["revision"]), 2, "trace detail must expose the latest active cumulative revision");
      const callIds = new Set((calls as Array<Record<string, unknown>>).map((event) => String(event["id"])));
      assert.equal((usage as Array<Record<string, unknown>>).some((component) => callIds.has(String(component["id"]))), false, "call and usage rows must not be merged into one trace item");
      assert.equal(bodyContains(ownerBody, fixture.projectKey), false, "trace detail must never expose the raw project DSN key");

      const viewerTrace = await roles.viewer.request(`/api/v1/projects/${fixture.projectId}/traces/${encodeURIComponent(CROSS_SDK_TRACE_ID)}`);
      expectStatus(viewerTrace, 200, "viewer cross-SDK trace detail");
      const viewerBody = apiBody(viewerTrace, "viewer cross-SDK trace detail");
      assert.equal(responseHasSensitiveField(viewerBody["events"]), false, "server-side trace serializer must redact viewer call bodies/source");
      assert.equal(responseHasSensitiveField(viewerBody["usageComponents"]), false, "server-side trace serializer must redact viewer usage metadata/source");
      assert.equal(bodyContains(viewerBody, fixture.projectKey), false, "viewer trace detail must not expose the raw project DSN key");
      return `trace ${CROSS_SDK_TRACE_ID} returned ${calls.length} call row(s), ${lifecycle.length} lifecycle row(s), and ${usage.length} usage components as separate collections; owner/viewer serializers omitted the DSN key and restricted source/body fields`;
    },
  );

  await ledger.recordCheck(
    ["F04", "AC13"],
    "Scoped overview and trends",
    "local-http",
    async () => {
      const overview = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/overview?from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
      expectStatus(overview, 200, "overview");
      const overviewBody = apiBody(overview, "overview");
      const nested = overviewBody["overview"] as Record<string, unknown> | undefined;
      assert.ok(nested && Number(nested["total_calls"]) >= 4, "overview must count local fixture calls");
      assert.ok(Number(nested["total_cost"]) > 0, "overview must expose known spend");

      const summary = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/summary`);
      expectStatus(summary, 200, "summary");
      const summaryBody = apiBody(summary, "summary");
      assert.ok(summaryBody["thisMonth"] && typeof summaryBody["thisMonth"] === "object");

      const trends = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/trends?range=7d&bucket=day`);
      expectStatus(trends, 200, "trends");
      const trendsBody = apiBody(trends, "trends");
      assert.ok(Array.isArray(trendsBody["trends"]), "trends must expose an array");
      return `overview, summary, and ${trendsBody["trends"].length} trend buckets used one project/time scope`;
    },
  );

  await ledger.recordCheck(
    ["F01", "DX02", "DX10", "AC06"],
    "Missing sourcemap guidance",
    "local-http",
    async () => {
      const health = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/health`);
      expectStatus(health, 200, "project health");
      const healthBody = apiBody(health, "project health");
      assert.ok(Array.isArray(healthBody["hints"]), "health must expose guidance hints");
      const hints = healthBody["hints"] as unknown[];
      assert.ok(hints.some((hint) => JSON.stringify(hint).includes("sourcemap")), "bundled fixture should produce source-map guidance");
      return "bundled stack fixture produced targeted health guidance";
    },
  );
}

async function runProjectScopedEventIdProbe(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  baseUrl: string,
): Promise<void> {
  await ledger.recordCheck(
    ["F01", "F02", "DX01", "DX07", "AC01", "AC02", "AC17"],
    "Identical event IDs remain isolated across projects",
    "local-http",
    async () => {
      const eventId = "evt_acceptance_same_id_two_projects";
      const submit = async (projectKey: string, projectId: string, traceId: string): Promise<void> => {
        const response = await new HttpClient(baseUrl).request("/api/v1/events", {
          method: "POST",
          headers: { authorization: `Bearer ${projectKey}` },
          body: {
            sdkVersion: "acceptance-project-scoped-id",
            events: [{
              id: eventId,
              timestamp: new Date().toISOString(),
              provider: "openai",
              model: "gpt-4o-mini",
              url: "https://api.openai.com/v1/chat/completions",
              method: "POST",
              statusCode: 200,
              usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
              durationMs: 12,
              streaming: false,
              context: { traceId, traceName: "acceptance-project-scoped-id", environment: "test" },
              requestBody: null,
              responseBody: null,
            }],
          },
        });
        expectStatus(response, 202, `project-scoped ingest ${projectId}`);
      };

      await submit(fixture.projectKey, fixture.projectId, "trace_acceptance_same_id_local");
      await submit(fixture.otherProjectKey, fixture.otherProjectId, "trace_acceptance_same_id_other");
      const rows = await pool.query<{ id: string; project_id: string; cost: number | null }>(
        `SELECT id, project_id, cost_usd AS cost
         FROM events WHERE id = $1 AND project_id = ANY($2::text[])
         ORDER BY project_id`,
        [eventId, [fixture.projectId, fixture.otherProjectId]],
      );
      assert.equal(rows.rows.length, 2, "one envelope ID must persist independently in both projects");
      assert.deepEqual(new Set(rows.rows.map((row) => row.project_id)), new Set([fixture.projectId, fixture.otherProjectId]));
      assert.ok(rows.rows.every((row) => row.id === eventId && row.cost != null), "both project rows must retain local pricing");
      const global = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM events WHERE id = $1", [eventId]);
      assert.equal(global.rows[0]?.count, "2", "composite project/event identity must not collapse cross-project envelopes");
      return `same event ID ${eventId} was accepted under two DSNs and persisted as two priced rows, one per project, with no cross-project merge`;
    },
  );
}

async function runFeatureMappingProbe(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  roles: RoleClients,
  baseUrl: string,
): Promise<void> {
  let workerMappingId: string | null = null;
  let explicitMappingId: string | null = null;
  const futureEventId = "evt_acceptance_feature_future";

  try {
    await ledger.recordCheck(
      ["F03", "AC03"],
      "Feature mapping preview and historical relabel preserve cost",
      "local-http",
      async () => {
        const mappingPath = `/api/v1/projects/${fixture.projectId}/feature-mappings`;
        const create = await roles.developer.request(mappingPath, {
          method: "POST",
          body: {
            feature: "mapped-worker",
            match: {
              provider: "openai",
              model: "gpt-4o-mini",
              function: "runWorker",
              service: "worker",
              environment: "test",
            },
          },
        });
        expectStatus(create, 201, "developer feature mapping create");
        const created = apiBody(create, "developer feature mapping create");
        assert.equal(typeof created["id"], "string", "feature mapping create must return an ID");
        workerMappingId = String(created["id"]);

        const viewerCreate = await roles.viewer.request(mappingPath, {
          method: "POST",
          body: { feature: "viewer-must-not-write", match: { model: "gpt-4o-mini" } },
        });
        expectStatus(viewerCreate, 403, "viewer feature mapping create");

        const before = await pool.query<{ cost: number | null }>(
          "SELECT cost_usd AS cost FROM events WHERE id = $1",
          [fixture.eventIds.unassigned],
        );
        const preview = await roles.developer.request(
          `${mappingPath}/${encodeURIComponent(workerMappingId)}/preview`,
        );
        expectStatus(preview, 200, "feature mapping preview");
        const previewBody = apiBody(preview, "feature mapping preview");
        const previewResult = objectValue(previewBody["preview"]);
        assert.ok(previewResult, "feature mapping preview must return a preview object");
        assert.equal(previewResult["matchedCount"], 1, "preview must match the unassigned worker event");
        assert.equal(previewResult["unpricedCount"], 0, "worker fixture must be priced");
        assert.ok(Array.isArray(previewResult["eventIds"]) && previewResult["eventIds"].includes(fixture.eventIds.unassigned));

        const apply = await roles.developer.request(
          `${mappingPath}/${encodeURIComponent(workerMappingId)}/apply`,
          { method: "POST", body: { confirm: true } },
        );
        expectStatus(apply, 200, "developer historical feature mapping apply");
        const applyBody = apiBody(apply, "developer historical feature mapping apply");
        assert.equal(applyBody["matchedCount"], 1, "historical mapping must relabel one unassigned event");
        assert.equal(typeof applyBody["actionId"], "string", "historical mapping must return an action ID");

        const after = await pool.query<{
          feature: string | null;
          source: string | null;
          mapping: string | null;
          cost: number | null;
          function_name: string | null;
        }>(
          `SELECT context->>'feature' AS feature, feature_source AS source,
                  feature_mapping_id AS mapping, cost_usd AS cost, bl_function AS function_name
           FROM events WHERE id = $1`,
          [fixture.eventIds.unassigned],
        );
        assert.equal(after.rows[0]?.feature, "mapped-worker");
        assert.equal(after.rows[0]?.source, "mapping");
        assert.equal(after.rows[0]?.mapping, workerMappingId);
        assert.equal(after.rows[0]?.function_name, "runWorker", "mapping must retain function identity");
        assert.equal(after.rows[0]?.cost, before.rows[0]?.cost, "mapping must not alter the event cost");
        return `developer preview matched one unassigned runWorker event; apply returned durable action ${String(applyBody["actionId"])} and left cost unchanged at ${String(after.rows[0]?.cost)}`;
      },
    );

    if (!workerMappingId) {
      ledger.recordBlocked(["F03", "AC03"], "Feature mapping follow-up probes", "Initial mapping creation did not produce an ID");
      return;
    }

    await ledger.recordCheck(
      ["F03", "F12", "AC03", "AC15"],
      "Explicit feature precedence, owner override, and mapping history",
      "local-http",
      async () => {
        const mappingPath = `/api/v1/projects/${fixture.projectId}/feature-mappings`;
        const create = await roles.developer.request(mappingPath, {
          method: "POST",
          body: {
            feature: "mapped-explicit",
            match: { provider: "openai", model: "gpt-4o-mini", function: "search" },
          },
        });
        expectStatus(create, 201, "explicit feature mapping create");
        const created = apiBody(create, "explicit feature mapping create");
        explicitMappingId = String(created["id"]);

        const preview = await roles.developer.request(
          `${mappingPath}/${encodeURIComponent(explicitMappingId)}/preview`,
        );
        expectStatus(preview, 200, "explicit feature mapping preview");
        const previewBody = apiBody(preview, "explicit feature mapping preview");
        const previewResult = objectValue(previewBody["preview"]);
        assert.ok(previewResult);
        assert.equal(previewResult["matchedCount"], 0, "explicit SDK feature must win without an override");

        const before = await pool.query<{ cost: number | null; feature: string | null }>(
          "SELECT cost_usd AS cost, context->>'feature' AS feature FROM events WHERE id = $1",
          [fixture.eventIds.retry],
        );
        const developerOverride = await roles.developer.request(
          `${mappingPath}/${encodeURIComponent(explicitMappingId)}/apply`,
          { method: "POST", body: { confirm: true, overrideExplicit: true } },
        );
        expectStatus(developerOverride, 403, "developer explicit feature override");

        const ownerOverride = await roles.owner.request(
          `${mappingPath}/${encodeURIComponent(explicitMappingId)}/apply`,
          { method: "POST", body: { confirm: true, overrideExplicit: true } },
        );
        expectStatus(ownerOverride, 200, "owner explicit feature override");
        const ownerBody = apiBody(ownerOverride, "owner explicit feature override");
        assert.equal(ownerBody["matchedCount"], 1, "owner override must relabel the explicit retry event");

        const after = await pool.query<{
          cost: number | null;
          feature: string | null;
          source: string | null;
          original: string | null;
        }>(
          `SELECT cost_usd AS cost, context->>'feature' AS feature,
                  feature_source AS source, feature_original AS original
           FROM events WHERE id = $1`,
          [fixture.eventIds.retry],
        );
        assert.equal(after.rows[0]?.feature, "mapped-explicit");
        assert.equal(after.rows[0]?.source, "mapping_override");
        assert.equal(after.rows[0]?.original, before.rows[0]?.feature);
        assert.equal(after.rows[0]?.cost, before.rows[0]?.cost, "override must not alter the retry cost");

        const history = await pool.query<{
          action: string;
          matched_count: number;
          override_explicit: boolean;
        }>(
          `SELECT action, matched_count, override_explicit
           FROM feature_mapping_actions
           WHERE project_id = $1 AND mapping_id IN ($2, $3)
           ORDER BY created_at ASC`,
          [fixture.projectId, workerMappingId, explicitMappingId],
        );
        assert.ok(history.rows.some((row) => row.action === "historical_relabel" && row.matched_count === 1 && row.override_explicit === false));
        assert.ok(history.rows.some((row) => row.action === "historical_relabel" && row.matched_count === 1 && row.override_explicit === true));
        return `preview protected explicit SDK label; developer override was denied, owner override relabelled one event without changing ${String(after.rows[0]?.cost)} cost, and ${history.rows.length} durable mapping actions were recorded`;
      },
    );

    await ledger.recordCheck(
      ["F03", "DX02", "AC03"],
      "Future ingest receives reusable feature mapping provenance",
      "local-http",
      async () => {
        const response = await new HttpClient(baseUrl).request("/api/v1/events", {
          method: "POST",
          headers: { authorization: `Bearer ${fixture.projectKey}` },
          body: {
            sdkVersion: "acceptance-feature-mapping",
            events: [{
              id: futureEventId,
              timestamp: new Date().toISOString(),
              provider: "openai",
              model: "gpt-4o-mini",
              url: "https://api.openai.com/v1/chat/completions",
              method: "POST",
              statusCode: 200,
              usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
              durationMs: 35,
              streaming: false,
              context: {
                environment: "test",
                service: "worker",
                traceId: "trace_acceptance_feature_future",
                traceName: "acceptance-feature-future",
              },
              callSite: {
                raw: "at runWorker (src/worker.ts:17:1)",
                frames: [{ fileName: "src/worker.ts", functionName: "runWorker", lineNumber: 17, columnNumber: 1 }],
              },
              requestBody: null,
              responseBody: null,
            }],
          },
        });
        expectStatus(response, 202, "future mapped ingest");
        const result = await pool.query<{
          feature: string | null;
          source: string | null;
          mapping: string | null;
          function_name: string | null;
          cost: number | null;
        }>(
          `SELECT context->>'feature' AS feature, feature_source AS source,
                  feature_mapping_id AS mapping, bl_function AS function_name,
                  cost_usd AS cost
           FROM events WHERE id = $1`,
          [futureEventId],
        );
        assert.equal(result.rows.length, 1, "future mapped event must persist");
        assert.equal(result.rows[0]?.feature, "mapped-worker");
        assert.equal(result.rows[0]?.source, "mapping");
        assert.equal(result.rows[0]?.mapping, workerMappingId);
        assert.equal(result.rows[0]?.function_name, "runWorker");
        assert.ok(result.rows[0]?.cost != null, "future mapped event must retain normal pricing");
        return `future runWorker ingest was automatically mapped to ${workerMappingId} with source provenance and known cost ${String(result.rows[0]?.cost)}`;
      },
    );
  } finally {
    // Restore the synthetic explicit-label fixture so a later check cannot
    // mistake the override for a second independent call. Mapping actions
    // remain durable evidence until the disposable database is removed.
    await pool.query(
      `UPDATE events
       SET context = jsonb_set(COALESCE(context, '{}'::jsonb), '{feature}', to_jsonb('search'::text), TRUE),
           feature_source = 'explicit', feature_mapping_id = NULL,
           feature_mapping_action_id = NULL, feature_original = NULL
       WHERE id = $1`,
      [fixture.eventIds.retry],
    ).catch(() => undefined);
    for (const mappingId of [explicitMappingId, workerMappingId]) {
      if (!mappingId) continue;
      await roles.owner.request(
        `/api/v1/projects/${fixture.projectId}/feature-mappings/${encodeURIComponent(mappingId)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
    }
  }
}

async function runSdkHttpProbe(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  baseUrl: string,
): Promise<void> {
  await ledger.recordCheck(
    ["F01", "DX01", "DX02", "DX03", "DX04", "AC01", "AC02"],
    "TypeScript SDK captures a mocked supported-provider response over local HTTP",
    "local-http",
    async () => {
      const originalFetch = globalThis.fetch;
      let providerCalls = 0;
      let configCalls = 0;
      let configFailures = 0;
      const startedAt = new Date();
      const configUrl = `${baseUrl}/api/v1/projects/${fixture.projectId}/config`;

      // Install a provider-only mock before CostKey.init. The SDK's transport
      // still reaches the local CostKey HTTP server through originalFetch;
      // requests to a provider hostname never leave this process.
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).hostname === "api.openai.com") {
          providerCalls++;
          return new Response(JSON.stringify({
            id: "chatcmpl_acceptance",
            model: "gpt-4o",
            choices: [{ message: { role: "assistant", content: "local mock" } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url === configUrl || url === `${configUrl}/`) {
          configCalls++;
          const configResponse = await originalFetch(input, init);
          if (!configResponse.ok) configFailures++;
          return configResponse;
        }
        return originalFetch(input, init);
      };

      try {
        CostKey.init({
          dsn: `http://${encodeURIComponent(fixture.projectKey)}@${new URL(baseUrl).host}/${fixture.projectId}`,
          captureBody: false,
          maxBatchSize: 1,
          flushInterval: 60_000,
        });
        await CostKey.withContext(
          { environment: "acceptance", traceId: CROSS_SDK_TRACE_ID, traceName: CROSS_SDK_TRACE_NAME },
          async () => {
            const carrier = CostKey.exportContext();
            const carrierHeaders = CostKey.exportContextHeaders();
            assert.deepEqual(carrier, { traceId: CROSS_SDK_TRACE_ID, traceName: CROSS_SDK_TRACE_NAME, environment: "acceptance" }, "context export must be allowlisted");
            assert.equal(carrierHeaders["x-costkey-context"], JSON.stringify(carrier), "context headers must be explicit caller output");
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "local-only" }] }),
            });
            assert.equal(response.status, 200);
            await response.json();
          },
        );

        const deadline = Date.now() + 4_000;
        let captured = 0;
        while (Date.now() < deadline) {
          await CostKey.flush();
          const count = await pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM events
             WHERE project_id = $1 AND provider = 'openai' AND created_at >= $2`,
            [fixture.projectId, startedAt.toISOString()],
          );
          captured = Number(count.rows[0]?.count ?? 0);
          if (captured >= 1) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(providerCalls, 1, "provider call must be served by the in-process mock");
        assert.ok(captured >= 1, "SDK event must reach local ingest over HTTP");
        const configDeadline = Date.now() + 2_000;
        while (configCalls < 1 && Date.now() < configDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.ok(configCalls >= 1, "SDK init must fetch DSN runtime config before claiming connection readiness");
        assert.equal(configFailures, 0, "SDK runtime config must return a successful response");

        return `SDK provider mock calls=${providerCalls}; runtime config calls=${configCalls}; local ingest persisted ${captured} event(s); explicit carrier was allowlisted; no provider network was used`;
      } finally {
        await CostKey.shutdown();
        globalThis.fetch = originalFetch;
      }
    },
  );
}

async function runTypeScriptPrivacyTransitionProbe(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  roles: RoleClients,
  baseUrl: string,
): Promise<void> {
  await ledger.recordCheck(
    ["F12", "DX01", "DX02", "AC01", "AC19"],
    "TypeScript SDK follows metadata/text/metadata privacy transitions",
    "local-http",
    async () => {
      const originalFetch = globalThis.fetch;
      let providerCalls = 0;
      let configCalls = 0;
      const configPath = `/api/v1/projects/${fixture.projectId}/config`;
      const providerSecret = "sk-acceptance-transition-secret-0123456789";
      const traces = {
        metadata: "trace_acceptance_ts_privacy_metadata",
        text: "trace_acceptance_ts_privacy_text",
        metadataAgain: "trace_acceptance_ts_privacy_metadata_again",
      };
      const dsn = `http://${encodeURIComponent(fixture.projectKey)}@${new URL(baseUrl).host}/${fixture.projectId}`;

      const rowForTrace = async (traceId: string): Promise<Record<string, unknown>> => {
        let row: Record<string, unknown> | undefined;
        await waitUntil(async () => {
          const result = await pool.query(
            `SELECT id, url, content_status, request_body, response_body,
                    system_prompt, metadata, context
             FROM events WHERE project_id = $1 AND trace_id = $2
             ORDER BY created_at DESC LIMIT 1`,
            [fixture.projectId, traceId],
          );
          row = result.rows[0] as Record<string, unknown> | undefined;
          return !!row;
        }, 5_000, `TypeScript privacy event ${traceId}`);
        return row as Record<string, unknown>;
      };

      const setPrivacy = async (captureMode: "metadata" | "text"): Promise<void> => {
        const response = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/privacy`, {
          method: "PATCH",
          body: {
            captureMode,
            redactionEnabled: true,
          },
        });
        expectStatus(response, 200, `owner privacy ${captureMode}`);
      };

      const callProvider = async (traceId: string, marker: string): Promise<Record<string, unknown>> => {
        await CostKey.withContext(
          { environment: "acceptance-privacy", traceId, traceName: "acceptance-ts-privacy" },
          async () => {
            const response = await fetch(`https://api.openai.com/v1/chat/completions?api_key=${encodeURIComponent(providerSecret)}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: "gpt-4o",
                api_key: providerSecret,
                messages: [
                  { role: "system", content: "private system transition" },
                  { role: "user", content: marker },
                ],
              }),
            });
            assert.equal(response.status, 200, "local provider mock must return success");
            await response.json();
          },
        );
        await CostKey.flush();
        return rowForTrace(traceId);
      };

      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const parsed = new URL(url);
        if (parsed.hostname === "api.openai.com") {
          providerCalls++;
          return new Response(JSON.stringify({
            id: `chatcmpl_acceptance_privacy_ts_${providerCalls}`,
            model: "gpt-4o",
            choices: [{ message: { role: "assistant", content: `local response ${providerCalls}` } }],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (parsed.pathname === configPath) configCalls++;
        return originalFetch(input, init);
      };

      try {
        await setPrivacy("metadata");
        CostKey.init({
          dsn,
          captureBody: true,
          maxBatchSize: 1,
          flushInterval: 60_000,
          configRefreshInterval: 50,
        });
        await waitUntil(() => configCalls >= 1, 3_000, "TypeScript metadata runtime config");
        const metadata = await callProvider(traces.metadata, "ts-metadata-marker");
        assert.equal(metadata["request_body"], null, "metadata-only TS call must omit request body");
        assert.equal(metadata["response_body"], null, "metadata-only TS call must omit response body");
        assert.equal(metadata["system_prompt"], null, "metadata-only TS call must omit system prompt");
        assert.equal(metadata["metadata"], null, "metadata-only TS call must omit body-derived metadata");
        assert.equal(metadata["content_status"], "metadata_only");
        assert.equal(metadata["url"], "https://api.openai.com/v1/chat/completions", "provider URL must strip query credentials");
        assert.equal(bodyContains(metadata, providerSecret), false, "metadata-only event must not contain provider secret");

        const beforeTextConfig = configCalls;
        await setPrivacy("text");
        await waitUntil(() => configCalls > beforeTextConfig, 3_000, "TypeScript text runtime config refresh");
        await sleep(120);
        const text = await callProvider(traces.text, "ts-text-marker");
        assert.ok(text["request_body"] && text["response_body"], "text capture must retain provider bodies");
        assert.equal(bodyContains(text["request_body"], "ts-text-marker"), true);
        assert.equal(bodyContains(text["request_body"], providerSecret), false, "captured TS body must scrub provider secret values");
        const requestBody = objectValue(text["request_body"]);
        assert.equal(requestBody?.["api_key"], "[REDACTED]", "captured TS body must redact credential-key fields");
        assert.equal(text["content_status"], "captured");
        assert.equal(text["url"], "https://api.openai.com/v1/chat/completions");

        const beforeMetadataAgain = configCalls;
        await setPrivacy("metadata");
        await waitUntil(() => configCalls > beforeMetadataAgain, 3_000, "TypeScript metadata runtime config revocation");
        await sleep(120);
        const metadataAgain = await callProvider(traces.metadataAgain, "ts-metadata-again-marker");
        assert.equal(metadataAgain["request_body"], null, "metadata reversion must omit request body");
        assert.equal(metadataAgain["response_body"], null, "metadata reversion must omit response body");
        assert.equal(metadataAgain["system_prompt"], null, "metadata reversion must omit system prompt");
        assert.equal(metadataAgain["metadata"], null, "metadata reversion must omit body-derived metadata");
        assert.equal(metadataAgain["content_status"], "metadata_only");
        assert.equal(providerCalls, 3, "three real SDK provider calls must be mocked locally");
        return `TS SDK made three automatic provider calls through one local DSN: metadata-only bodies absent, text capture retained a redacted body, and a short refresh returned to metadata-only; config refreshes=${configCalls}`;
      } finally {
        await CostKey.shutdown();
        globalThis.fetch = originalFetch;
        await setPrivacy("metadata").catch(() => undefined);
      }
    },
  );
}

async function runSdkUsageProbe(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  baseUrl: string,
): Promise<void> {
  await ledger.recordCheck(
    ["F08", "DX08", "AC12"],
    "TypeScript SDK recordUsage emits canonical envelopes through local /events",
    "local-http",
    async () => {
      const originalFetch = globalThis.fetch;
      try {
        CostKey.init({
          dsn: `http://${encodeURIComponent(fixture.projectKey)}@${new URL(baseUrl).host}/${fixture.projectId}`,
          captureBody: false,
          maxBatchSize: 1,
          flushInterval: 60_000,
        });
        const usage = {
          componentId: "voice:acceptance",
          chargeId: "charge_acceptance_sdk",
          aggregation: "cumulative" as const,
          provider: "local-voice",
          model: "local-tts",
          usage: { seconds: 10 },
          amount: { value: 0.12, currency: "USD" },
          unit: "seconds",
          context: { traceId: "trace_acceptance_voice", executionId: "execution_acceptance_voice" },
        };
        await CostKey.recordUsage({ id: "usage_acceptance_sdk_1", revision: 1, ...usage });
        // An exact duplicate envelope must be absorbed by the SDK ledger.
        await CostKey.recordUsage({ id: "usage_acceptance_sdk_1", revision: 1, ...usage });
        await CostKey.recordUsage({
          id: "usage_acceptance_sdk_2",
          revision: 2,
          ...usage,
          usage: { seconds: 20 },
          amount: { value: 0.24, currency: "USD" },
        });

        const deadline = Date.now() + 4_000;
        let usageRows: Array<{ id: string; amount: number | null; charge_id: string | null; revision: number | null; aggregation: string }> = [];
        while (Date.now() < deadline) {
          await CostKey.flush();
          const result = await pool.query<{ id: string; amount: number | null; charge_id: string | null; revision: number | null; aggregation: string }>(
            `SELECT id, amount, charge_id, revision, aggregation
             FROM usage_components WHERE project_id = $1 AND id IN ('usage_acceptance_sdk_1', 'usage_acceptance_sdk_2')
             ORDER BY id`,
            [fixture.projectId],
          );
          usageRows = result.rows;
          if (usageRows.length >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(usageRows.length, 2, "SDK explicit usage revisions must reach local ingest once each");
        assert.ok(usageRows.every((row) => row.charge_id === "charge_acceptance_sdk" && row.aggregation === "cumulative"));
        assert.equal(usageRows[0]?.amount, 0.12);
        assert.equal(usageRows[1]?.amount, 0.24);
        return "TS recordUsage sent two cumulative revisions through /api/v1/events; duplicate envelope was absorbed; canonical usage rows preserved charge/revision identity";
      } finally {
        await CostKey.shutdown();
        globalThis.fetch = originalFetch;
      }
    },
  );
}

async function runDsnConfigProbe(
  ledger: EvidenceLedger,
  fixture: AcceptanceFixture,
  baseUrl: string,
): Promise<void> {
  await ledger.recordCheck(
    ["F01", "DX01", "DX10", "AC01"],
    "DSN-authenticated project config wire",
    "local-http",
    async () => {
      const client = new HttpClient(baseUrl);
      const response = await client.request(`/api/v1/projects/${fixture.projectId}/config`, {
        headers: { authorization: `Bearer ${fixture.projectKey}` },
      });
      expectStatus(response, 200, "DSN project config");
      const body = apiBody(response, "DSN project config");
      assert.equal(body["projectId"], fixture.projectId, "DSN project config must identify the authenticated project");
      assert.ok(body["capture"] && typeof body["capture"] === "object", "DSN project config must expose capture capabilities");
      assert.ok(Array.isArray(body["providers"]), "DSN project config must expose provider capabilities");
      assert.equal(Object.prototype.hasOwnProperty.call(body, "authKey"), false, "config response must not echo the DSN secret");
      assert.equal(Object.prototype.hasOwnProperty.call(body, "dsn"), false, "config response must not echo the DSN");
      return `DSN config returned ${body["providers"].length} provider capability entries without echoing credentials`;
    },
  );
}

async function runPythonSdkUsageProbe(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  baseUrl: string,
): Promise<void> {
  const pythonRoot = process.env["COSTKEY_PYTHON_ROOT"] ?? "/Users/naman/Code/costkey-python";
  const pythonBin = process.env["COSTKEY_PYTHON_BIN"] ?? "/opt/homebrew/bin/python3";
  try {
    await access(path.join(pythonRoot, "costkey", "client.py"));
    await access(pythonBin);
  } catch {
    ledger.recordBlocked(["F08", "DX08", "AC12"], "Python SDK record_usage subprocess", "The Python SDK source or interpreter is unavailable; raw HTTP is intentionally not used as a substitute");
    return;
  }

  await ledger.recordCheck(
    ["F08", "DX08", "AC12"],
    "Python SDK record_usage emits canonical envelopes through local /events",
    "local-http",
    async () => {
      const host = new URL(baseUrl).host;
      const dsn = `http://${encodeURIComponent(fixture.projectKey)}@${host}/${fixture.projectId}`;
      const script = [
        "import socket",
        "_connect = socket.socket.connect",
        "def _local_connect(sock, address):\n    host = address[0] if isinstance(address, tuple) else ''\n    if host not in {'127.0.0.1', 'localhost', '::1'}:\n        raise RuntimeError('local acceptance network guard blocked non-loopback egress')\n    return _connect(sock, address)",
        "socket.socket.connect = _local_connect",
        "import costkey",
        `costkey.init(dsn=${JSON.stringify(dsn)}, capture_body=False, max_batch_size=1, flush_interval=60.0)`,
        `with costkey.with_context(environment='acceptance-python', traceId=${JSON.stringify(CROSS_SDK_TRACE_ID)}, traceName=${JSON.stringify(CROSS_SDK_TRACE_NAME)}):\n    assert costkey.export_context() == {'traceId': ${JSON.stringify(CROSS_SDK_TRACE_ID)}, 'traceName': ${JSON.stringify(CROSS_SDK_TRACE_NAME)}, 'environment': 'acceptance-python'}\n    assert 'x-costkey-context' in costkey.export_context_headers()`,
        `common = dict(component_id='voice:python-acceptance', charge_id='charge_python_acceptance', provider='local-voice', model='local-tts', unit='seconds', aggregation='cumulative', context={'traceId':${JSON.stringify(CROSS_SDK_TRACE_ID)},'traceName':${JSON.stringify(CROSS_SDK_TRACE_NAME)},'executionId':'execution_python_voice'})`,
        "costkey.record_usage(event_id='usage_python_sdk_1', revision=1, usage={'seconds': 10}, amount={'value': 0.12, 'currency': 'USD'}, **common)",
        "costkey.record_usage(event_id='usage_python_sdk_2', revision=2, usage={'seconds': 20}, amount={'value': 0.24, 'currency': 'USD'}, **common)",
        "costkey.flush()",
        "costkey.shutdown()",
      ].join("\n");
      await runChildProcess(pythonBin, ["-c", script], {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        PYTHONPATH: pythonRoot,
        PYTHONUNBUFFERED: "1",
      });

      const deadline = Date.now() + 4_000;
      let usageRows: Array<{ id: string; amount: number | null; charge_id: string | null; revision: number | null; aggregation: string }> = [];
      while (Date.now() < deadline) {
        const result = await pool.query<{ id: string; amount: number | null; charge_id: string | null; revision: number | null; aggregation: string }>(
          `SELECT id, amount, charge_id, revision, aggregation
           FROM usage_components WHERE project_id = $1 AND id IN ('usage_python_sdk_1', 'usage_python_sdk_2')
           ORDER BY id`,
          [fixture.projectId],
        );
        usageRows = result.rows;
        if (usageRows.length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(usageRows.length, 2, "Python SDK usage revisions must reach local ingest once each");
      assert.ok(usageRows.every((row) => row.charge_id === "charge_python_acceptance" && row.aggregation === "cumulative"));
      assert.equal(usageRows[0]?.amount, 0.12);
      assert.equal(usageRows[1]?.amount, 0.24);
      const connected = await pool.query<{ events: string; usages: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM events WHERE project_id = $1 AND trace_id = $2) AS events,
           (SELECT COUNT(*)::text FROM usage_components WHERE project_id = $1 AND trace_id = $2) AS usages`,
        [fixture.projectId, CROSS_SDK_TRACE_ID],
      );
      assert.ok(Number(connected.rows[0]?.events ?? 0) >= 1, "shared cross-SDK trace must include the TypeScript call");
      assert.equal(Number(connected.rows[0]?.usages ?? 0), 2, "shared cross-SDK trace must include both Python usage revisions");
      const trace = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM traces WHERE project_id = $1 AND id = $2",
        [fixture.projectId, CROSS_SDK_TRACE_ID],
      );
      assert.equal(Number(trace.rows[0]?.count ?? 0), 1, "shared cross-SDK trace must have one durable trace identity");
      return "Python record_usage sent two cumulative revisions through /api/v1/events; canonical rows preserved charge/revision identity and joined one durable TypeScript trace";
    },
  );
}

async function runPythonPrivacyTransitionProbe(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  roles: RoleClients,
  baseUrl: string,
): Promise<void> {
  const pythonRoot = process.env["COSTKEY_PYTHON_ROOT"] ?? "/Users/naman/Code/costkey-python";
  const pythonBin = process.env["COSTKEY_PYTHON_BIN"] ?? "/opt/homebrew/bin/python3";
  try {
    await access(path.join(pythonRoot, "costkey", "client.py"));
    await access(pythonBin);
  } catch {
    ledger.recordBlocked(["F12", "DX01", "DX02", "AC01", "AC02"], "Python SDK privacy transition subprocess", "The Python SDK source or interpreter is unavailable; raw HTTP is intentionally not used as a substitute");
    return;
  }

  await ledger.recordCheck(
    ["F12", "DX01", "DX02", "AC01", "AC02"],
    "Python SDK follows metadata/text/metadata privacy transitions",
    "local-http",
    async () => {
      const script = [
        "import os, socket, time",
        "import httpx",
        "real_connect = socket.socket.connect",
        "def local_connect(sock, address):",
        "    host = address[0] if isinstance(address, tuple) else ''",
        "    if host not in {'127.0.0.1', 'localhost', '::1'}:",
        "        raise RuntimeError('local acceptance network guard blocked non-loopback egress')",
        "    return real_connect(sock, address)",
        "socket.socket.connect = local_connect",
        "provider_calls = 0",
        "real_send = httpx.Client.send",
        "def provider_mock(self, request, **kwargs):",
        "    global provider_calls",
        "    if request.url.host == 'api.openai.com':",
        "        provider_calls += 1",
        "        return httpx.Response(200, json={'id': 'chatcmpl_acceptance_python_privacy_' + str(provider_calls), 'model': 'gpt-4o', 'choices': [{'message': {'role': 'assistant', 'content': 'local python response'}}], 'usage': {'prompt_tokens': 21, 'completion_tokens': 9, 'total_tokens': 30}}, request=request)",
        "    return real_send(self, request, **kwargs)",
        "httpx.Client.send = provider_mock",
        "import costkey",
        "base = os.environ['ACCEPTANCE_BASE_URL']",
        "project = os.environ['ACCEPTANCE_PROJECT_ID']",
        "dsn = 'http://' + os.environ['ACCEPTANCE_PROJECT_KEY'] + '@' + base.removeprefix('http://') + '/' + project",
        "client = httpx.Client(base_url=base)",
        "login = client.post('/auth/login', json={'email': 'owner@acceptance.invalid', 'password': os.environ['ACCEPTANCE_PASSWORD']})",
        "if login.status_code != 200: raise RuntimeError('local owner login failed: ' + str(login.status_code))",
        "token = login.json().get('token')",
        "if not isinstance(token, str) or not token: raise RuntimeError('local owner login did not return a token')",
        "headers = {'Authorization': 'Bearer ' + token}",
        "privacy_url = '/api/v1/projects/' + project + '/privacy'",
        "def set_privacy(mode):",
        "    response = client.patch(privacy_url, headers=headers, json={'captureMode': mode, 'redactionEnabled': True})",
        "    if response.status_code != 200: raise RuntimeError('local privacy update failed: ' + str(response.status_code))",
        "def wait_config():",
        "    deadline = time.time() + 5",
        "    while time.time() < deadline and costkey.get_runtime_config_status() != 'available': time.sleep(0.02)",
        "    if costkey.get_runtime_config_status() != 'available': raise RuntimeError('Python SDK runtime config did not become available')",
        "def call(trace, marker):",
        "    secret = 'sk-acceptance-python-transition-secret-0123456789'",
        "    with costkey.with_context(traceId=trace, traceName='acceptance-python-privacy', environment='acceptance-python-privacy'):",
        "        response = client.post('https://api.openai.com/v1/chat/completions?api_key=' + secret, json={'model': 'gpt-4o', 'api_key': secret, 'messages': [{'role': 'system', 'content': 'private python system'}, {'role': 'user', 'content': marker}]})",
        "        if response.status_code != 200: raise RuntimeError('local Python provider mock failed: ' + str(response.status_code))",
        "    costkey.flush()",
        "set_privacy('metadata')",
        "costkey.init(dsn=dsn, capture_body=True, max_batch_size=1, flush_interval=60.0, config_refresh_interval=0.05, scan_callgraph=False)",
        "wait_config()",
        "call('trace_acceptance_py_privacy_metadata', 'py-metadata-marker')",
        "set_privacy('text')",
        "time.sleep(0.20)",
        "call('trace_acceptance_py_privacy_text', 'py-text-marker')",
        "set_privacy('metadata')",
        "time.sleep(0.20)",
        "call('trace_acceptance_py_privacy_metadata_again', 'py-metadata-again-marker')",
        "if provider_calls != 3: raise RuntimeError('expected three locally mocked Python provider calls')",
        "costkey.shutdown()",
        "client.close()",
      ].join("\n");
      await runChildProcess(pythonBin, ["-c", script], {
        PATH: process.env["PATH"] ?? "/opt/homebrew/bin:/usr/bin:/bin",
        PYTHONPATH: pythonRoot,
        PYTHONUNBUFFERED: "1",
        ACCEPTANCE_BASE_URL: baseUrl,
        ACCEPTANCE_PROJECT_ID: fixture.projectId,
        ACCEPTANCE_PROJECT_KEY: fixture.projectKey,
        ACCEPTANCE_PASSWORD,
      });

      const rowForTrace = async (traceId: string): Promise<Record<string, unknown>> => {
        let row: Record<string, unknown> | undefined;
        await waitUntil(async () => {
          const result = await pool.query(
            `SELECT id, url, content_status, request_body, response_body,
                    system_prompt, metadata, context
             FROM events WHERE project_id = $1 AND trace_id = $2
             ORDER BY created_at DESC LIMIT 1`,
            [fixture.projectId, traceId],
          );
          row = result.rows[0] as Record<string, unknown> | undefined;
          return !!row;
        }, 5_000, `Python privacy event ${traceId}`);
        return row as Record<string, unknown>;
      };

      const metadata = await rowForTrace("trace_acceptance_py_privacy_metadata");
      assert.equal(metadata["request_body"], null, "metadata-only Python call must omit request body");
      assert.equal(metadata["response_body"], null, "metadata-only Python call must omit response body");
      assert.equal(metadata["system_prompt"], null, "metadata-only Python call must omit system prompt");
      assert.equal(metadata["metadata"], null, "metadata-only Python call must omit body-derived metadata");
      assert.equal(metadata["content_status"], "metadata_only");
      assert.equal(metadata["url"], "https://api.openai.com/v1/chat/completions");

      const text = await rowForTrace("trace_acceptance_py_privacy_text");
      const providerSecret = "sk-acceptance-python-transition-secret-0123456789";
      assert.ok(text["request_body"] && text["response_body"], "Python text capture must retain provider bodies");
      assert.equal(bodyContains(text["request_body"], "py-text-marker"), true);
      assert.equal(bodyContains(text["request_body"], providerSecret), false, "captured Python body must scrub provider secrets");
      assert.equal(objectValue(text["request_body"])?.["api_key"], "[REDACTED]");
      assert.equal(text["content_status"], "captured");
      assert.equal(text["url"], "https://api.openai.com/v1/chat/completions");

      const metadataAgain = await rowForTrace("trace_acceptance_py_privacy_metadata_again");
      assert.equal(metadataAgain["request_body"], null, "Python metadata reversion must omit request body");
      assert.equal(metadataAgain["response_body"], null, "Python metadata reversion must omit response body");
      assert.equal(metadataAgain["system_prompt"], null, "Python metadata reversion must omit system prompt");
      assert.equal(metadataAgain["metadata"], null, "Python metadata reversion must omit body-derived metadata");
      assert.equal(metadataAgain["content_status"], "metadata_only");
      return "Python SDK automatic provider interception followed one local DSN through metadata-only, text-with-redaction, and metadata-only transitions; body/url privacy was observed in durable events";
    },
  );
  await roles.owner.request(`/api/v1/projects/${fixture.projectId}/privacy`, {
    method: "PATCH",
    body: { captureMode: "metadata", redactionEnabled: true },
  }).catch(() => undefined);
}

async function runChildProcess(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("child process timed out after 15 seconds"));
    }, 15_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = redactChildOutput(stderr.trim()).replace(/[\r\n]+/g, " ").slice(0, 300);
      reject(new Error(`child process exited ${code ?? `via ${signal ?? "unknown signal"}`}${suffix ? `: ${suffix}` : ""}`));
    });
  });
}

async function runSdkLifecycleProbe(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  baseUrl: string,
): Promise<void> {
  await ledger.recordCheck(
    ["F07", "DX05", "DX06", "DX07", "AC10", "AC11"],
    "TypeScript SDK grouped execution lifecycle reaches local accounting",
    "local-http",
    async () => {
      const originalFetch = globalThis.fetch;
      try {
        CostKey.init({
          dsn: `http://${encodeURIComponent(fixture.projectKey)}@${new URL(baseUrl).host}/${fixture.projectId}`,
          captureBody: false,
          maxBatchSize: 10,
          flushInterval: 60_000,
        });
        await CostKey.startExecution(
          {
            name: "acceptance-nightly-import",
            kind: "batch",
            groupId: "group_acceptance_nightly",
            executionId: "execution_acceptance_first",
            expectedItems: 1,
            configuration: { source: "fixture", revision: "local" },
          },
          async () => undefined,
        );
        const deadline = Date.now() + 4_000;
        let executionRows: Array<Record<string, unknown>> = [];
        while (Date.now() < deadline) {
          await CostKey.flush();
          const result = await pool.query(
            `SELECT id, group_id, state, expected_items, configuration
             FROM executions WHERE project_id = $1 AND id = $2`,
            [fixture.projectId, "execution_acceptance_first"],
          );
          executionRows = result.rows as Array<Record<string, unknown>>;
          if (executionRows.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(executionRows.length, 1, "grouped execution lifecycle must create one durable execution");
        assert.equal(executionRows[0]?.group_id, "group_acceptance_nightly");
        assert.equal(Number(executionRows[0]?.expected_items), 1);
        return "SDK startExecution emitted one fresh execution receipt with stable group identity and supplied configuration";
      } finally {
        await CostKey.shutdown();
        globalThis.fetch = originalFetch;
      }
    },
  );
}

async function runRoleAndExportProbes(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  roles: RoleClients,
): Promise<void> {
  await ledger.recordCheck(
    ["F12", "AC15", "AC19"],
    "Role identities and project isolation",
    "local-http",
    async () => {
      const me = await roles.owner.json<{ user?: { role?: string }; projects?: Array<{ id?: string }> }>("/auth/me");
      const meBody = jsonBody<{ user?: { role?: string }; projects?: Array<{ id?: string }> }>(me, "owner auth/me");
      assert.equal(meBody.user?.role, "owner");
      assert.ok(meBody.projects?.some((project) => project.id === fixture.projectId), "owner must see acceptance project");

      for (const role of ["admin", "developer", "viewer"] as const) {
        const roleMe = await roles[role].json<{ user?: { role?: string }; projects?: Array<{ id?: string }> }>("/auth/me");
        const roleBody = jsonBody<{ user?: { role?: string }; projects?: Array<{ id?: string }> }>(roleMe, `${role} auth/me`);
        assert.equal(roleBody.user?.role, role);
        assert.ok(roleBody.projects?.some((project) => project.id === fixture.projectId), `${role} must see assigned acceptance project`);
        assert.equal(roleBody.projects?.some((project) => project.id === fixture.otherProjectId), false, `${role} must not see the other organization's project assignment`);
      }

      const crossOrg = await roles.viewer.request(`/api/v1/projects/${fixture.otherProjectId}/summary`);
      expectStatus(crossOrg, 404, "viewer cross-org project");
      return "owner/admin/developer/viewer identities were read from the DB; same-org project was visible and cross-org project returned 404";
    },
  );

  await ledger.recordCheck(
    ["F02", "F11", "F12", "AC15", "AC18"],
    "Viewer aggregate access and content/source redaction",
    "local-http",
    async () => {
      const aggregate = await roles.viewer.request(`/api/v1/projects/${fixture.projectId}/summary`);
      expectStatus(aggregate, 200, "viewer aggregate summary");

      const list = await roles.viewer.request(`/api/v1/projects/${fixture.projectId}/events?limit=50`);
      expectStatus(list, 200, "viewer event list");
      const listBody = apiBody(list, "viewer event list");
      assert.equal(responseHasSensitiveField(listBody["events"]), false, "viewer event list must not expose body/source fields");

      const detail = await roles.viewer.request(`/api/v1/projects/${fixture.projectId}/events/${fixture.eventIds.known}`);
      expectStatus(detail, 200, "viewer event detail");
      const detailBody = apiBody(detail, "viewer event detail");
      assert.equal(responseHasSensitiveField(detailBody["event"]), false, "viewer event detail must not expose body/source fields");
      return "viewer received aggregate data without captured body/source fields";
    },
  );

  await ledger.recordCheck(
    ["F11", "AC18"],
    "Filtered event dataset and pagination",
    "local-http",
    async () => {
      const first = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/events?model=gpt-4o&limit=1&offset=0`);
      expectStatus(first, 200, "filtered event page 1");
      const firstBody = apiBody(first, "filtered event page 1");
      const firstEvents = firstBody["events"];
      assert.ok(Array.isArray(firstEvents) && firstEvents.length <= 1, "page 1 must respect limit");
      assert.ok(firstEvents.every((event) => (event as Record<string, unknown>)["model"] === "gpt-4o"), "model filter must apply to every returned row");
      assert.ok(Number(firstBody["total"]) >= 2, "fixture should expose at least two gpt-4o rows");

      const second = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/events?model=gpt-4o&limit=1&offset=1`);
      expectStatus(second, 200, "filtered event page 2");
      const secondBody = apiBody(second, "filtered event page 2");
      const secondEvents = secondBody["events"];
      assert.ok(Array.isArray(secondEvents) && secondEvents.length <= 1, "page 2 must respect limit");
      assert.ok(secondEvents.every((event) => (event as Record<string, unknown>)["model"] === "gpt-4o"), "model filter must apply to every returned page");
      const firstId = (firstEvents[0] as Record<string, unknown> | undefined)?.["id"];
      const secondId = (secondEvents[0] as Record<string, unknown> | undefined)?.["id"];
      assert.notEqual(firstId, secondId, "pagination pages must not repeat the same row");
      return `model filter returned total=${firstBody["total"]}; page IDs were distinct`;
    },
  );

  await ledger.recordCheck(
    ["F12"],
    "Non-owner member and policy writes are blocked",
    "local-http",
    async () => {
      const invite = await roles.viewer.request("/api/v1/team/invite", {
        method: "POST",
        body: { email: "blocked@acceptance.invalid", role: "member" },
      });
      expectStatus(invite, 403, "viewer invite write");

      const rule = await roles.developer.request(`/api/v1/projects/${fixture.projectId}/budget/policies`, {
        method: "POST",
        body: { name: "blocked-rule", allowance: 1, unit: "money", window: "calendar_day", mode: "monitor", currency: "USD" },
      });
      expectStatus(rule, 403, "developer budget write");

      const adminRule = await roles.admin.request(`/api/v1/projects/${fixture.projectId}/budget/policies`, {
        method: "POST",
        body: { name: "local-acceptance-rule", allowance: 1, unit: "money", window: "calendar_day", periodStart: "activation", mode: "monitor", currency: "USD" },
      });
      if (adminRule.status === 404 || adminRule.status === 405) {
        ledger.recordNotImplemented(["F06"], "Canonical policy role write", `HTTP ${adminRule.status}; canonical /budget/policies is not mounted`);
        return `viewer invite=${invite.status}, developer policy=${rule.status}; canonical admin policy route is not mounted`;
      }
      expectStatus(adminRule, 201, "admin budget write");
      return `viewer invite=${invite.status}, developer policy=${rule.status}, admin policy=${adminRule.status}`;
    },
  );

  await ledger.recordCheck(
    ["F12", "AC19"],
    "Viewer project creation is denied",
    "local-http",
    async () => {
      const create = await roles.viewer.request("/api/v1/projects", {
        method: "POST",
        body: { name: "__acceptance_viewer_must_not_create__" },
      });
      expectStatus(create, 403, "viewer project creation");
      if (create.status === 201) {
        const body = apiBody(create, "unexpected viewer project creation");
        const id = typeof body["id"] === "string" ? body["id"] : null;
        if (id) {
          await pool.query("DELETE FROM projects WHERE id = $1 AND org_id = $2", [id, fixture.orgId]);
        }
      }
      return "viewer could not create a project";
    },
  );

  await ledger.recordCheck(
    ["F12", "AC19"],
    "Privacy, retention, and subscription role surfaces",
    "local-http",
    async () => {
      const privacy = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/privacy`);
      expectStatus(privacy, 200, "owner privacy settings");
      const privacyBody = apiBody(privacy, "owner privacy settings");
      assert.ok(privacyBody["settings"] && typeof privacyBody["settings"] === "object");

      const viewerPrivacy = await roles.viewer.request(`/api/v1/projects/${fixture.projectId}/privacy`);
      expectStatus(viewerPrivacy, 200, "viewer privacy settings");
      const viewerPrivacyBody = apiBody(viewerPrivacy, "viewer privacy settings");
      assert.equal(viewerPrivacyBody["canManage"], false, "viewer must not manage capture settings");

      const retention = await roles.owner.request("/api/v1/retention/status");
      expectStatus(retention, 200, "retention status");
      const subscription = await roles.owner.request("/api/v1/subscription");
      expectStatus(subscription, 200, "owner subscription");
      const adminSubscription = await roles.admin.request("/api/v1/subscription");
      expectStatus(adminSubscription, 403, "admin subscription boundary");
      return "owner/viewer privacy access and owner-only subscription visibility were checked without changing settings or billing";
    },
  );

  await probeExport(ledger, fixture, roles);
}

async function probeExport(
  ledger: EvidenceLedger,
  fixture: AcceptanceFixture,
  roles: RoleClients,
): Promise<void> {
  // The PRD requires CSV aggregate export but does not name a legacy route;
  // keep one canonical seam here rather than guessing multiple paths. If the
  // backend contract settles on another path, update this single descriptor.
  const path = `/api/v1/projects/${fixture.projectId}/export?format=csv&model=gpt-4o&limit=1&offset=0`;
  const label = `aggregate export ${path}`;
  let owner: HttpResult<unknown>;
  try {
    owner = await roles.owner.request(path);
  } catch (error) {
    ledger.addCheck(["F11", "AC18"], label, "fail", "local-http", `request failed before response: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (owner.status === 404 || owner.status === 405) {
    ledger.recordNotImplemented(["F11", "AC18"], label, `Route is absent (${owner.status}); CSV/JSON export contract is not implemented in this server.`);
    return;
  }
  if (owner.status < 200 || owner.status >= 300) {
    ledger.addCheck(["F11", "AC18"], label, "fail", "local-http", `Owner export returned HTTP ${owner.status}: ${safeBody(owner.body)}`);
    return;
  }

  const contentType = owner.headers.get("content-type") ?? "";
  if (!/(csv|json)/i.test(contentType)) {
    ledger.recordNotImplemented(["F11", "AC18"], label, `HTTP ${owner.status} returned ${contentType || "no content type"}; this is likely the SPA fallback, not a CSV/JSON export route.`);
    return;
  }
  if (owner.rawBody.length === 0) {
    ledger.addCheck(["F11", "AC18"], label, "fail", "local-http", "CSV/JSON export returned an empty body");
    return;
  }

  let viewer: HttpResult<unknown>;
  try {
    viewer = await roles.viewer.request(path);
  } catch (error) {
    ledger.addCheck(["F11", "F12", "AC15", "AC18"], `${label} viewer boundary`, "fail", "local-http", `viewer request failed before response: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (viewer.status === 403 || viewer.status === 404) {
    ledger.addCheck(["F11", "F12", "AC15", "AC18"], `${label} viewer boundary`, "pass", "local-http", `owner export ${owner.status}; viewer denied with ${viewer.status}`);
  } else if (viewer.status >= 200 && viewer.status < 300) {
    if (viewer.rawBody.includes(fixture.sensitiveMarker)) {
      ledger.addCheck(["F11", "F12", "AC15", "AC18"], `${label} viewer boundary`, "fail", "local-http", "viewer export leaked the captured-body marker");
    } else {
      ledger.addCheck(["F11", "F12", "AC15", "AC18"], `${label} viewer boundary`, "pass", "local-http", `viewer received aggregate export with no captured-body marker (HTTP ${viewer.status})`);
    }
  } else {
    ledger.addCheck(["F11", "F12", "AC15", "AC18"], `${label} viewer boundary`, "fail", "local-http", `viewer export returned unexpected HTTP ${viewer.status}`);
  }
  ledger.addCheck(["F11", "AC18"], label, "pass", "local-http", `owner export returned ${contentType}; viewer boundary was checked`);
}

async function runFilterAndFullExportProbe(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  roles: RoleClients,
): Promise<void> {
  const base = `/api/v1/projects/${fixture.projectId}`;
  const repeatedFilter = "model=gpt-4o&model=gpt-4o-mini&provider=openai";
  await ledger.recordCheck(
    ["F03", "F11", "F12", "AC03", "AC15", "AC18"],
    "Full-cohort filter options and OR/AND list/export semantics",
    "local-http",
    async () => {
      const options = await roles.owner.request(`${base}/filter-options?${repeatedFilter}`);
      expectStatus(options, 200, "full-cohort filter options");
      const optionsBody = apiBody(options, "full-cohort filter options");
      const scope = objectValue(optionsBody["scope"]);
      const available = objectValue(optionsBody["availableFilters"]);
      assert.ok(scope && available, "filter options must expose scope and availableFilters");
      assert.deepEqual(scope["model"], ["gpt-4o", "gpt-4o-mini"], "repeated model filters must be represented as an OR set");
      assert.equal(scope["provider"], "openai", "provider dimension must remain an AND predicate");
      assert.equal(optionsBody["complete"], true, "default filter options must cover the full scoped cohort");
      const models = available["models"];
      const providers = available["providers"];
      assert.ok(Array.isArray(models) && models.includes("gpt-4o") && models.includes("gpt-4o-mini"), "filter options must use the full scoped cohort, not the first page");
      assert.deepEqual(providers, ["openai"], "provider options must reflect the AND-constrained cohort");
      const contexts = objectValue(available["contexts"]);
      const environment = objectValue(contexts?.["environment"]);
      assert.ok(Array.isArray(environment?.["values"]) && environment["values"].includes("test"), "repeated filter options must retain safe context dimensions");
      assert.equal(responseHasSensitiveField(optionsBody), false, "filter options must not expose body/source payloads");

      const firstOptionPage = await roles.owner.request(`${base}/filter-options?${repeatedFilter}&limit=1&offset=0`);
      expectStatus(firstOptionPage, 200, "first paginated filter-options page");
      const firstOptionBody = apiBody(firstOptionPage, "first paginated filter-options page");
      assert.equal(firstOptionBody["limit"], 1);
      assert.equal(firstOptionBody["offset"], 0);
      assert.equal(firstOptionBody["complete"], false, "a deliberately narrow filter-options page must advertise remaining values");
      assert.equal(firstOptionBody["nextCursor"], "1");
      const secondOptionPage = await roles.owner.request(`${base}/filter-options?${repeatedFilter}&limit=1&offset=1`);
      expectStatus(secondOptionPage, 200, "second paginated filter-options page");
      const secondOptionBody = apiBody(secondOptionPage, "second paginated filter-options page");
      const firstPageFilters = objectValue(firstOptionBody["availableFilters"]);
      const secondPageFilters = objectValue(secondOptionBody["availableFilters"]);
      const pagedModels = [...(Array.isArray(firstPageFilters?.["models"]) ? firstPageFilters["models"] : []), ...(Array.isArray(secondPageFilters?.["models"]) ? secondPageFilters["models"] : [])];
      assert.ok(pagedModels.includes("gpt-4o") && pagedModels.includes("gpt-4o-mini"), "filter-options cursors must reconstruct the complete model cohort");

      const firstPage = await roles.owner.request(`${base}/events?${repeatedFilter}&limit=1&offset=0`);
      expectStatus(firstPage, 200, "OR/AND filtered event page");
      const firstBody = apiBody(firstPage, "OR/AND filtered event page");
      const firstEvents = firstBody["events"];
      assert.ok(Array.isArray(firstEvents) && firstEvents.length === 1, "paginated event list must honor limit=1");
      assert.ok(Number(firstBody["total"]) > 1, "filtered cohort must contain more than one row");
      assert.ok((firstEvents as Array<Record<string, unknown>>).every((event) => event["provider"] === "openai" && ["gpt-4o", "gpt-4o-mini"].includes(String(event["model"]))), "list must apply model OR and provider AND together");

      const exportResult = await roles.owner.request(`${base}/export?format=json&${repeatedFilter}&limit=1&offset=9999`);
      expectStatus(exportResult, 200, "full filtered JSON export");
      const exportBody = apiBody(exportResult, "full filtered JSON export");
      const exported = exportBody["events"];
      assert.ok(Array.isArray(exported) && exported.length > 1, "export must ignore explorer pagination and return the full filtered dataset");
      assert.equal((objectValue(exportBody["scope"]) ?? {})["paginationApplied"], false, "export must explicitly report that pagination was not applied");
      assert.equal(exportBody["matchedCount"], exported.length, "export matchedCount must equal returned rows");
      assert.ok((exported as Array<Record<string, unknown>>).every((event) => event["provider"] === "openai" && ["gpt-4o", "gpt-4o-mini"].includes(String(event["model"]))), "export must apply every requested dimension");
      assert.equal((exportBody["includeContent"] ?? false), false, "default export must be metadata-only");
      assert.equal(bodyContains(exported, fixture.sensitiveMarker), false, "metadata export must not include captured bodies");

      const dbUnique = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM (SELECT DISTINCT COALESCE(charge_id, id) AS charge_key
               FROM events
               WHERE project_id = $1 AND provider = 'openai' AND model IN ('gpt-4o', 'gpt-4o-mini')
                 AND COALESCE(event_type, 'call') = 'call') cohort`,
        [fixture.projectId],
      );
      assert.equal(Number(exportBody["matchedCount"]), Number(dbUnique.rows[0]?.count ?? 0), "canonical export must reconcile to the unique charge cohort");

      const viewerOptions = await roles.viewer.request(`${base}/filter-options?${repeatedFilter}`);
      expectStatus(viewerOptions, 200, "viewer filter options");
      const viewerOptionsBody = apiBody(viewerOptions, "viewer filter options");
      const viewerAvailable = objectValue(viewerOptionsBody["availableFilters"]);
      assert.deepEqual(viewerAvailable?.["functions"], [], "viewer filter options must not expose source functions");
      assert.equal(responseHasSensitiveField(viewerOptionsBody), false, "viewer filter options must remain aggregate-only");

      const contentExport = await roles.owner.request(`${base}/export?format=json&includeContent=true&model=gpt-4o`);
      expectStatus(contentExport, 200, "owner content export");
      const contentBody = apiBody(contentExport, "owner content export");
      assert.equal(contentBody["includeContent"], true);
      assert.ok(bodyContains(contentBody["events"], fixture.sensitiveMarker), "authorized content export must preserve the captured fixture body");

      const viewerContentExport = await roles.viewer.request(`${base}/export?format=json&includeContent=true&model=gpt-4o`);
      expectStatus(viewerContentExport, 403, "viewer content export");
      return `full filter cohort exposed ${models.length} models and one provider; paginated list total=${firstBody["total"]}, canonical export returned ${exported.length} unique charges beyond offset=9999, and viewer content/source stayed restricted`;
    },
  );
}

async function runSavedViewAndForecastPrivacyProbe(
  ledger: EvidenceLedger,
  fixture: AcceptanceFixture,
  roles: RoleClients,
  baseUrl: string,
): Promise<void> {
  let privateViewId: string | null = null;
  let sharedViewId: string | null = null;
  let privateSavedScenarioId: string | null = null;
  let privateForecastScenarioId: string | null = null;
  let sharedForecastScenarioId: string | null = null;

  try {
    await ledger.recordCheck(
      ["F09", "F11", "F12", "DX10", "AC13", "AC15", "AC19"],
      "Saved-view privacy, shared links, and scenario calculation",
      "local-http",
      async () => {
        const privateView = await roles.owner.request("/api/v1/saved-views", {
          method: "POST",
          body: {
            name: "Acceptance private cohort",
            kind: "view",
            visibility: "private",
            projectId: fixture.projectId,
            definition: {
              model: ["gpt-4o", "gpt-4o-mini"],
              provider: "openai",
              request_body: { mustNotPersist: fixture.sensitiveMarker },
            },
          },
        });
        expectStatus(privateView, 201, "owner private saved view");
        const privateBody = apiBody(privateView, "owner private saved view");
        const privateRow = objectValue(privateBody["view"]);
        assert.ok(privateRow && typeof privateRow["id"] === "string");
        privateViewId = String(privateRow["id"]);
        assert.equal(bodyContains(privateRow["definition"], "mustNotPersist"), false, "saved view definitions must strip captured-body keys");

        const ownerLink = await roles.owner.request(`/api/v1/saved-views/${encodeURIComponent(privateViewId)}/copy-link`, { method: "POST" });
        expectStatus(ownerLink, 200, "owner private saved-view link");
        const ownerLinkBody = apiBody(ownerLink, "owner private saved-view link");
        const ownerUrl = new URL(String(ownerLinkBody["url"]));
        assert.equal(ownerUrl.origin, new URL(baseUrl).origin, "saved-view deep link must remain same-origin");
        assert.equal(ownerUrl.searchParams.get("view"), privateViewId);
        assert.equal(String(ownerLinkBody["access"]), "requires_workspace_permission");

        const viewerPrivate = await roles.viewer.request(`/api/v1/saved-views/${encodeURIComponent(privateViewId)}`);
        expectStatus(viewerPrivate, 404, "viewer private saved view");
        const viewerPrivateLink = await roles.viewer.request(`/api/v1/saved-views/${encodeURIComponent(privateViewId)}/copy-link`, { method: "POST" });
        expectStatus(viewerPrivateLink, 404, "viewer private saved-view link");

        const viewerSharedCreate = await roles.viewer.request("/api/v1/saved-views", {
          method: "POST",
          body: { name: "viewer shared forbidden", visibility: "workspace", projectId: fixture.projectId, definition: {} },
        });
        expectStatus(viewerSharedCreate, 403, "viewer shared saved view create");

        const sharedView = await roles.developer.request("/api/v1/saved-views", {
          method: "POST",
          body: {
            name: "Acceptance shared cohort",
            kind: "view",
            visibility: "workspace",
            projectId: fixture.projectId,
            definition: { feature: "search", environment: "test" },
          },
        });
        expectStatus(sharedView, 201, "developer shared saved view");
        const sharedBody = apiBody(sharedView, "developer shared saved view");
        const sharedRow = objectValue(sharedBody["view"]);
        assert.ok(sharedRow && typeof sharedRow["id"] === "string");
        sharedViewId = String(sharedRow["id"]);

        const viewerShared = await roles.viewer.request(`/api/v1/saved-views/${encodeURIComponent(sharedViewId)}`);
        expectStatus(viewerShared, 200, "viewer shared saved view");
        const viewerSharedLink = await roles.viewer.request(`/api/v1/saved-views/${encodeURIComponent(sharedViewId)}/copy-link`, { method: "POST" });
        expectStatus(viewerSharedLink, 200, "viewer shared saved-view link");
        const viewerSharedLinkBody = apiBody(viewerSharedLink, "viewer shared saved-view link");
        const viewerSharedUrl = new URL(String(viewerSharedLinkBody["url"]));
        assert.equal(viewerSharedUrl.origin, new URL(baseUrl).origin);
        assert.equal(viewerSharedUrl.searchParams.get("view"), sharedViewId);
        const deepRoute = await roles.viewer.request(`${viewerSharedUrl.pathname}${viewerSharedUrl.search}`);
        expectStatus(deepRoute, 200, "viewer shared saved-view deep route");
        assert.ok(deepRoute.rawBody.length > 0, "saved-view deep route must return a non-empty app shell");
        assert.equal(bodyContains(deepRoute.rawBody, fixture.projectKey), false, "saved-view deep route must not embed the raw project DSN key");

        const privateScenario = await roles.owner.request("/api/v1/saved-views", {
          method: "POST",
          body: {
            name: "Acceptance private scenario",
            kind: "scenario",
            visibility: "private",
            projectId: fixture.projectId,
            definition: { baselineCost: 500, baselineOperations: 50_000, targetOperations: 50_000 },
          },
        });
        expectStatus(privateScenario, 201, "owner private saved scenario");
        const privateScenarioBody = apiBody(privateScenario, "owner private saved scenario");
        const privateScenarioRow = objectValue(privateScenarioBody["view"]);
        assert.ok(privateScenarioRow && typeof privateScenarioRow["id"] === "string");
        privateSavedScenarioId = String(privateScenarioRow["id"]);
        assert.equal(privateScenarioRow["kind"], "scenario");
        const viewerPrivateScenario = await roles.viewer.request(`/api/v1/saved-views/${encodeURIComponent(privateSavedScenarioId)}`);
        expectStatus(viewerPrivateScenario, 404, "viewer private saved scenario");

        const calculate = await roles.viewer.request("/api/v1/saved-views/scenario/calculate", {
          method: "POST",
          body: { baselineCost: 500, baselineOperations: 50_000, targetOperations: 50_000, source: "local acceptance" },
        });
        expectStatus(calculate, 200, "saved scenario calculation");
        const calculation = apiBody(calculate, "saved scenario calculation");
        assert.equal(calculation["projectedCost"], 500, "saved scenario calculation must preserve explicit units and cost");

        return `private view/scenario were owner-only; shared view was readable by Viewer through same-origin deep link ${sharedViewId}; body keys were scrubbed and scenario calculation stayed at $500 without provider work`;
      },
    );

    await ledger.recordCheck(
      ["F09", "F11", "F12", "AC13", "AC15"],
      "Forecast scenario private/shared role boundary",
      "local-http",
      async () => {
        const scenarioPath = `/api/v1/projects/${fixture.projectId}/forecast/scenarios`;
        const privateScenario = await roles.developer.request(scenarioPath, {
          method: "POST",
          body: {
            name: "Acceptance private forecast",
            shared: false,
            scope: { operations: 50_000, assumedCostPerOperation: 0.01 },
            assumptions: { source: "local acceptance" },
          },
        });
        expectStatus(privateScenario, 201, "developer private forecast scenario");
        const privateBody = apiBody(privateScenario, "developer private forecast scenario");
        assert.equal(typeof privateBody["id"], "string");
        privateForecastScenarioId = String(privateBody["id"]);
        const viewerPrivate = await roles.viewer.request(`${scenarioPath}/${encodeURIComponent(privateForecastScenarioId)}`);
        expectStatus(viewerPrivate, 404, "viewer private forecast scenario");

        const sharedScenario = await roles.developer.request(scenarioPath, {
          method: "POST",
          body: {
            name: "Acceptance shared forecast",
            shared: true,
            scope: { operations: 50_000, assumedCostPerOperation: 0.01 },
            assumptions: { source: "local acceptance" },
          },
        });
        expectStatus(sharedScenario, 201, "developer shared forecast scenario");
        const sharedBody = apiBody(sharedScenario, "developer shared forecast scenario");
        assert.equal(typeof sharedBody["id"], "string");
        sharedForecastScenarioId = String(sharedBody["id"]);
        const viewerShared = await roles.viewer.request(`${scenarioPath}/${encodeURIComponent(sharedForecastScenarioId)}`);
        expectStatus(viewerShared, 200, "viewer shared forecast scenario");
        const viewerSharedBody = apiBody(viewerShared, "viewer shared forecast scenario");
        const row = objectValue(viewerSharedBody["scenario"]);
        assert.equal(row?.["shared"], true);
        assert.equal(row?.["created_by"], ROLE_USER_IDS.developer);

        const list = await roles.viewer.request(scenarioPath);
        expectStatus(list, 200, "viewer forecast scenario list");
        const listBody = apiBody(list, "viewer forecast scenario list");
        assert.ok(Array.isArray(listBody["scenarios"]));
        assert.ok((listBody["scenarios"] as unknown[]).some((candidate) => String((candidate as Record<string, unknown>)["id"]) === sharedForecastScenarioId));
        assert.equal((listBody["scenarios"] as unknown[]).some((candidate) => String((candidate as Record<string, unknown>)["id"]) === privateForecastScenarioId), false, "private forecast scenario must not appear in Viewer list");
        return `developer-owned private forecast was hidden from Viewer while shared forecast ${sharedForecastScenarioId} was readable and listed with its owner identity`;
      },
    );
  } finally {
    for (const [path, id, client] of [
      ["/api/v1/saved-views", privateViewId, roles.owner],
      ["/api/v1/saved-views", sharedViewId, roles.owner],
      ["/api/v1/saved-views", privateSavedScenarioId, roles.owner],
    ] as const) {
      if (!id) continue;
      await client.request(`${path}/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    }
    const forecastPath = `/api/v1/projects/${fixture.projectId}/forecast/scenarios`;
    for (const id of [privateForecastScenarioId, sharedForecastScenarioId]) {
      if (!id) continue;
      await roles.owner.request(`${forecastPath}/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    }
  }
}

async function runNotificationAcceptanceProbe(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  roles: RoleClients,
): Promise<void> {
  let ownerWebhookId: string | null = null;
  let ownerEmailId: string | null = null;
  let viewerEmailId: string | null = null;
  const webhookSecret = "notification-acceptance-webhook-secret-012345";
  const webhookUrl = "http://127.0.0.1:9/costkey-acceptance";
  const fixedNow = new Date("2026-09-14T03:30:00.000Z");

  try {
    await ledger.recordCheck(
      ["F11", "F12", "DX10", "AC15", "AC20"],
      "Weekly catch-up summary, signed local delivery, scope, and dedupe",
      "local-http",
      async () => {
        const notifications = await loadLocalNotificationApi();
        notifications.clearLocalNotificationSink();

        const initial = await roles.owner.request(`/api/v1/notifications/preferences?projectId=${encodeURIComponent(fixture.projectId)}`);
        expectStatus(initial, 200, "project notification preference read");
        const initialBody = apiBody(initial, "project notification preference read");
        const initialPreferences = objectValue(initialBody["preferences"]);
        assert.equal(initialPreferences?.["explicit"], false, "weekly summary must begin as an implicit opt-in boundary");

        const viewerWrongRecipient = await roles.viewer.request("/api/v1/notifications/destinations", {
          method: "POST",
          body: {
            kind: "email",
            address: "owner@acceptance.invalid",
            projectId: fixture.projectId,
            eventTypes: ["weekly_summary"],
          },
        });
        expectStatus(viewerWrongRecipient, 403, "viewer cannot configure another recipient");

        const ownerWebhook = await roles.owner.request("/api/v1/notifications/destinations", {
          method: "POST",
          body: {
            kind: "webhook",
            address: webhookUrl,
            projectId: fixture.projectId,
            secret: webhookSecret,
            eventTypes: ["weekly_summary"],
          },
        });
        expectStatus(ownerWebhook, 201, "owner loopback webhook destination");
        const ownerWebhookBody = apiBody(ownerWebhook, "owner loopback webhook destination");
        ownerWebhookId = String(objectValue(ownerWebhookBody["destination"])?.["id"] ?? "");
        assert.ok(ownerWebhookId, "owner webhook destination must return an ID");

        const ownerEmail = await roles.owner.request("/api/v1/notifications/destinations", {
          method: "POST",
          body: {
            kind: "email",
            address: "owner@acceptance.invalid",
            projectId: fixture.projectId,
            eventTypes: ["weekly_summary"],
          },
        });
        expectStatus(ownerEmail, 201, "owner email destination");
        ownerEmailId = String(objectValue(apiBody(ownerEmail, "owner email destination")["destination"])?.["id"] ?? "");
        assert.ok(ownerEmailId);

        const viewerEmail = await roles.viewer.request("/api/v1/notifications/destinations", {
          method: "POST",
          body: {
            kind: "email",
            address: "viewer@acceptance.invalid",
            projectId: fixture.projectId,
            eventTypes: ["weekly_summary"],
          },
        });
        expectStatus(viewerEmail, 201, "viewer own email destination");
        viewerEmailId = String(objectValue(apiBody(viewerEmail, "viewer own email destination")["destination"])?.["id"] ?? "");
        assert.ok(viewerEmailId);

        const preferenceBody = {
          projectId: fixture.projectId,
          weeklySummaryEnabled: true,
          weeklySummaryWeekday: 1,
          weeklySummaryHour: 3,
          timezone: "UTC",
        };
        const ownerPreference = await roles.owner.request("/api/v1/notifications/preferences", {
          method: "PATCH",
          body: preferenceBody,
        });
        expectStatus(ownerPreference, 200, "owner project weekly preference");
        const ownerPreferenceRow = objectValue(apiBody(ownerPreference, "owner project weekly preference")["preferences"]);
        assert.equal(ownerPreferenceRow?.["weeklySummaryEnabled"], true);
        assert.equal(ownerPreferenceRow?.["weeklySummaryWeekday"], 1);
        assert.equal(ownerPreferenceRow?.["weeklySummaryHour"], 3);

        const viewerPreference = await roles.viewer.request("/api/v1/notifications/preferences", {
          method: "PATCH",
          body: preferenceBody,
        });
        expectStatus(viewerPreference, 200, "viewer project weekly preference");
        const viewerPreferenceRow = objectValue(apiBody(viewerPreference, "viewer project weekly preference")["preferences"]);
        assert.equal(viewerPreferenceRow?.["weeklySummaryEnabled"], true);

        const persisted = await pool.query<{
          user_id: string;
          project_id: string | null;
          weekly_summary_enabled: boolean;
          weekly_summary_weekday: number;
          weekly_summary_hour: number;
        }>(
          `SELECT user_id, project_id, weekly_summary_enabled,
                  weekly_summary_weekday, weekly_summary_hour
           FROM notification_preferences
           WHERE org_id = $1 AND project_id = $2 AND user_id = ANY($3::text[])
           ORDER BY user_id`,
          [fixture.orgId, fixture.projectId, [fixture.roleUserIds.owner, fixture.roleUserIds.viewer]],
        );
        assert.equal(persisted.rows.length, 2, "owner and viewer project preferences must be durable");
        assert.ok(persisted.rows.every((row) => row.project_id === fixture.projectId && row.weekly_summary_enabled && row.weekly_summary_weekday === 1 && row.weekly_summary_hour === 3));

        const attempted = await notifications.runWeeklyDigests(pool, fixedNow);
        assert.equal(attempted, 3, "weekly catch-up must deliver one scoped summary to each configured destination");
        const sink = notifications.getLocalNotificationSink();
        assert.equal(sink.length, 3, "memory sink must capture webhook plus both email deliveries");

        const webhook = sink.find((entry) => entry.url === webhookUrl);
        assert.ok(webhook, "signed webhook must reach the loopback memory sink");
        const webhookBody = JSON.parse(webhook.body) as Record<string, unknown>;
        assert.equal(webhookBody["eventType"], "weekly_summary");
        assert.equal(webhookBody["projectId"], fixture.projectId, "summary must retain project scope");
        const webhookScope = objectValue(webhookBody["scope"]);
        assert.equal(webhookScope?.["scopeId"], fixture.projectId);
        assert.equal(webhookScope?.["periodStart"], "2026-09-07T00:00:00.000Z");
        assert.equal(webhookScope?.["periodEnd"], "2026-09-14T00:00:00.000Z");
        assert.equal(typeof objectValue(webhookBody["evidence"])?.["calls"], "number");
        assert.equal(bodyContains(webhookBody, fixture.sensitiveMarker), false, "signed webhook payload must not include captured fixture content");
        assert.equal(bodyContains(webhookBody, "request_body"), false, "signed webhook payload must not include body field names");
        const timestamp = webhook.headers["X-CostKey-Timestamp"];
        const signature = webhook.headers["X-CostKey-Signature"];
        assert.ok(timestamp && signature, "signed webhook must include timestamp and signature headers");
        assert.equal(notifications.verifyWebhookSignature(webhookSecret, timestamp, webhook.body, signature), true, "webhook signature must cover the exact delivered body");

        const emails = sink.filter((entry) => entry.url.startsWith("email://"));
        assert.equal(emails.length, 2, "owner and viewer email destinations must receive scoped summaries");
        assert.ok(emails.every((entry) => !entry.body.includes(fixture.sensitiveMarker) && !entry.body.includes("request_body")), "email bodies must omit captured content and raw field names");
        assert.ok(emails.some((entry) => entry.url.includes("owner%40acceptance.invalid")));
        assert.ok(emails.some((entry) => entry.url.includes("viewer%40acceptance.invalid")));

        const outbox = await pool.query<{
          destination_id: string;
          user_id: string;
          scope_id: string | null;
          status: string;
          attempt_count: number;
          dedupe_key: string;
          payload: unknown;
        }>(
          `SELECT destination_id, user_id, scope_id, status, attempt_count, dedupe_key, payload
           FROM notification_deliveries
           WHERE org_id = $1 AND event_type = 'weekly_summary'
             AND scope_id = $2
           ORDER BY destination_id`,
          [fixture.orgId, fixture.projectId],
        );
        assert.equal(outbox.rows.length, 3, "weekly catch-up must create one outbox row per authorized destination");
        assert.ok(outbox.rows.every((row) => row.scope_id === fixture.projectId && row.status === "sent" && Number(row.attempt_count) === 1));
        assert.deepEqual(new Set(outbox.rows.map((row) => row.user_id)), new Set([fixture.roleUserIds.owner, fixture.roleUserIds.viewer]));
        assert.ok(outbox.rows.every((row) => row.dedupe_key.startsWith(`weekly_summary:${fixture.projectId}:`)));
        assert.ok(outbox.rows.every((row) => !bodyContains(row.payload, fixture.sensitiveMarker)));

        const sinkBeforeRepeat = sink.length;
        const repeated = await notifications.runWeeklyDigests(pool, new Date("2026-09-15T03:30:00.000Z"));
        assert.equal(repeated, 0, "next-day weekly catch-up must reuse the same period dedupe keys");
        assert.equal(notifications.getLocalNotificationSink().length, sinkBeforeRepeat, "deduped scheduler run must not resend local deliveries");
        const outboxAfterRepeat = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM notification_deliveries
           WHERE org_id = $1 AND event_type = 'weekly_summary' AND scope_id = $2`,
          [fixture.orgId, fixture.projectId],
        );
        assert.equal(outboxAfterRepeat.rows[0]?.count, "3");
        return `explicit owner/viewer preferences produced a scoped Monday catch-up with ${sink.length} memory deliveries (signed webhook + two email outbox rows), all sent once with no sensitive marker; next-day rerun was deduped`;
      },
    );
  } finally {
    for (const id of [ownerWebhookId, ownerEmailId, viewerEmailId]) {
      if (!id) continue;
      await roles.owner.request(`/api/v1/notifications/destinations/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    }
    await roles.owner.request("/api/v1/notifications/preferences", {
      method: "PATCH",
      body: { projectId: fixture.projectId, weeklySummaryEnabled: false },
    }).catch(() => undefined);
    await roles.viewer.request("/api/v1/notifications/preferences", {
      method: "PATCH",
      body: { projectId: fixture.projectId, weeklySummaryEnabled: false },
    }).catch(() => undefined);
    localNotificationApi?.clearLocalNotificationSink();
  }
}

async function runHistoricalAggregateRetentionProbe(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
): Promise<void> {
  await ledger.recordCheck(
    ["F04", "F12"],
    "Daily aggregate remains stored after 30-day detail retention",
    "local-fixture",
    async () => {
      const historicalApi = await loadLocalHistoricalApi();
      const now = new Date();
      const historicalAt = new Date(now.getTime() - 40 * 86_400_000);
      const historicalDay = historicalAt.toISOString().slice(0, 10);
      const currentDay = now.toISOString().slice(0, 10);
      const eventId = "evt_acceptance_historical_40d";
      const traceId = "trace_acceptance_historical_40d";
      await pool.query(
        `INSERT INTO events(
           id, project_id, timestamp, created_at, provider, model, url, method,
           status_code, input_tokens, output_tokens, total_tokens, cost_usd,
           cost_basis, cost_source, cost_currency, duration_ms, streaming,
           trace_id, trace_name, context, metadata, request_body, response_body,
           event_type, source, content_status, feature_source
         ) VALUES(
           $1, $2, $3, $3, 'openai', 'gpt-4o',
           'https://local.acceptance.invalid/v1/chat', 'POST', 200, 40, 10, 50,
           0.0042, 'reported', 'acceptance-historical', 'USD', 20, FALSE,
           $4, 'acceptance-historical', $5::jsonb, NULL, NULL, NULL,
           'call', 'fixture', 'unknown', 'explicit'
         )
         ON CONFLICT (project_id, id) DO UPDATE SET
           timestamp = EXCLUDED.timestamp, created_at = EXCLUDED.created_at,
           cost_usd = EXCLUDED.cost_usd, cost_basis = EXCLUDED.cost_basis,
           cost_source = EXCLUDED.cost_source, context = EXCLUDED.context,
           content_status = EXCLUDED.content_status`,
        [
          eventId,
          fixture.projectId,
          historicalAt.toISOString(),
          traceId,
          JSON.stringify({ feature: "historical", environment: "test", customer: "customer_historical", traceId, traceName: "acceptance-historical" }),
        ],
      );

      const oldGroups = await historicalApi.reconcileDailyCostAggregates(pool, fixture.projectId, historicalDay);
      assert.ok(oldGroups >= 1, "historical event must publish at least one daily aggregate group");
      // A current-day checkpoint is the explicit fence allowing the retention
      // worker to remove >30-day detail while preserving the old daily row.
      await historicalApi.reconcileDailyCostAggregates(pool, fixture.projectId, currentDay);
      const before = await pool.query<{ known: number | null; observations: number; day: string }>(
        `SELECT known_cost_usd AS known, observations, day::text AS day
         FROM daily_cost_aggregates
         WHERE project_id = $1 AND day = $2::date AND feature = 'historical'
         LIMIT 1`,
        [fixture.projectId, historicalDay],
      );
      assert.equal(before.rows.length, 1, "historical daily aggregate must be stored before detail purge");
      assert.equal(before.rows[0]?.known, 0.0042);
      assert.equal(Number(before.rows[0]?.observations), 1);

      const retention = await historicalApi.runRetention(pool, now, fixture.orgId);
      assert.ok(Number(retention.deletedEvents) >= 1, "retention must remove the old detail row after the aggregate fence");
      assert.equal(retention.blockedProjects?.includes(fixture.projectId), false, "acceptance project must have a current aggregate checkpoint");
      const detail = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM events WHERE project_id = $1 AND id = $2",
        [fixture.projectId, eventId],
      );
      assert.equal(detail.rows[0]?.count, "0", "old event detail must be purged after 30 days");
      const after = await pool.query<{ known: number | null; observations: number; trace_count: number }>(
        `SELECT known_cost_usd AS known, observations, trace_count
         FROM daily_cost_aggregates
         WHERE project_id = $1 AND day = $2::date AND feature = 'historical'
         LIMIT 1`,
        [fixture.projectId, historicalDay],
      );
      assert.equal(after.rows.length, 1, "daily aggregate must remain stored after detail purge");
      assert.equal(after.rows[0]?.known, 0.0042);
      assert.equal(Number(after.rows[0]?.observations), 1);
      assert.equal(Number(after.rows[0]?.trace_count), 1);
      return `40-day fixture detail was removed only after a current aggregate checkpoint; the durable ${historicalDay} aggregate remained stored with $0.0042, one observation, and one trace (table-level durability proof; no aggregate HTTP route was guessed)`;
    },
  );
}

async function runBudgetAndFailureProbes(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  roles: RoleClients,
  baseUrl: string,
): Promise<void> {
  await ledger.recordCheck(
    ["F06"],
    "Canonical policy CRUD and visibility",
    "local-http",
    async () => {
      const create = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/budget/policies`, {
        method: "POST",
        body: { name: "acceptance-monitor-only", mode: "monitor", status: "active", unit: "money", allowance: 100, currency: "USD", window: "calendar_day", periodStart: "activation", timezone: "UTC" },
      });
      if (create.status === 404 || create.status === 405) {
        ledger.recordNotImplemented(["F06"], "Canonical spending policy route", `HTTP ${create.status}; /api/v1/projects/:projectId/budget/policies is not mounted`);
        return "canonical spending policy route is not mounted";
      }
      expectStatus(create, 201, "owner policy create");
      const list = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/budget/policies`);
      expectStatus(list, 200, "owner policy list");
      const listBody = apiBody(list, "owner policy list");
      assert.ok(Array.isArray(listBody["policies"]), "policy list must expose policies array");
      const preview = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/budget/policies/preview`, {
        method: "POST",
        body: { mode: "monitor", status: "active", unit: "money", allowance: 100, currency: "USD", window: "calendar_day", timezone: "UTC", scope: { feature: "search" } },
      });
      expectStatus(preview, 200, "policy matching preview");
      const previewBody = apiBody(preview, "policy matching preview");
      assert.ok(previewBody["matchingHistory"] && typeof previewBody["matchingHistory"] === "object", "policy preview must expose matching history");

      const columns = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM spending_policies WHERE project_id = $1",
        [fixture.projectId],
      );
      assert.ok(Number(columns.rows[0]?.count) >= 1, "budget fixture should be durable");
      return `owner canonical policy list returned ${listBody["policies"].length} rows and persisted them in spending_policies`;
    },
  );

  await runAdmissionFailureProbes(ledger, pool, fixture, roles.owner, baseUrl);
}

async function runAdmissionFailureProbes(
  ledger: EvidenceLedger,
  pool: pg.Pool,
  fixture: AcceptanceFixture,
  owner: HttpClient,
  baseUrl: string,
): Promise<void> {
  const ids = ["F06", "DX09", "AC07", "AC08", "AC09"] as const;
  const dsn = new HttpClient(baseUrl);
  const request = async (body: Record<string, unknown>): Promise<HttpResult<unknown>> => dsn.request("/api/v1/sdk/policy/admit", {
    method: "POST",
    headers: { authorization: `Bearer ${fixture.projectKey}` },
    body,
  });
  const common = {
    // The positive concurrency journey must reach reservation accounting.
    // Use a provider/model present in the server-owned capability registry;
    // caller-supplied capability booleans are tested separately below.
    provider: "openai",
    integration: { supported: true, admissionSupported: true, capabilityVersion: "acceptance/1", verified: true },
    scope: {},
    context: { feature: "search", environment: "test" },
  };

  let moneyPolicyId: string | null = null;
  try {
    const moneyPolicy = await owner.request(`/api/v1/projects/${fixture.projectId}/budget/policies`, {
      method: "POST",
      body: {
        name: "acceptance-unknown-price",
        mode: "enforce",
        status: "active",
        unit: "money",
        allowance: 1,
        currency: "USD",
        window: "calendar_day",
        timezone: "UTC",
        periodStart: "activation",
        capabilityReview: { supported: true, admissionSupported: true, capabilityVersion: "acceptance/1", verified: true },
      },
    });
    if (moneyPolicy.status === 404 || moneyPolicy.status === 405) {
      ledger.recordNotImplemented(ids, "Canonical spending policy route", `HTTP ${moneyPolicy.status}; /api/v1/projects/:projectId/budget/policies is not mounted`);
      return;
    }
    expectStatus(moneyPolicy, 201, "owner money enforcement policy create");
    const moneyBody = apiBody(moneyPolicy, "owner money enforcement policy create");
    moneyPolicyId = typeof moneyBody["id"] === "string" ? moneyBody["id"] : null;
    assert.ok(moneyPolicyId, "policy create must return an id");
  } catch (error) {
    ledger.addCheck(["F06", "DX09"], "Canonical spending policy route", "fail", "local-http", error instanceof Error ? error.message : String(error));
    return;
  }

  await ledger.recordCheck(
    ["F06", "DX09", "AC08"],
    "Caller capability booleans cannot authorize an unknown provider",
    "local-http",
    async () => {
      const unknownProvider = await request({
        ...common,
        provider: "unknown-acceptance-provider",
        model: "gpt-4o",
        admissionId: "acceptance-unknown-capability",
        requestId: "acceptance-provider-unknown-capability",
        usageBounds: { maxInputTokens: 100, maxOutputTokens: 100 },
        claimedCostUsd: 0,
      });
      assert.ok(unknownProvider.status >= 400 && unknownProvider.status < 600, "unknown provider must not return an allow success");
      const body = apiBody(unknownProvider, "unknown provider capability refusal");
      assert.equal(body["decision"], "refuse", "unknown provider must return a typed refusal");
      assert.equal(body["reason"], "unsupported_integration", "unknown provider must be refused by the server registry");
      assert.equal(body["error"], "COSTKEY_POLICY_REFUSED");
      return `server-owned capability registry refused unknown-acceptance-provider despite integration.supported=true and admissionSupported=true claims (HTTP ${unknownProvider.status})`;
    },
  );

  try {
    const unknown = await request({
      ...common,
      admissionId: "acceptance-unknown-price",
      requestId: "acceptance-provider-unknown-price",
      model: "unknown-acceptance-model",
      usageBounds: { maxInputTokens: 100, maxOutputTokens: 100 },
      claimedCostUsd: 0.001,
    });
    if (unknown.status === 404 || unknown.status === 405) {
      ledger.recordNotImplemented(["F06", "DX09", "AC08"], "Canonical policy admission route", `HTTP ${unknown.status}; /api/v1/sdk/policy/admit is not mounted`);
    } else {
      const body = apiBody(unknown, "unknown-price admission");
      assert.ok(unknown.status >= 400 && unknown.status < 600, "unknown price must not return an allow success");
      assert.equal(body["decision"], "refuse", "unknown required price must return a refusal decision");
      assert.ok(["price_unavailable", "decision_unavailable", "unsupported_integration"].includes(String(body["reason"])), "unknown price refusal must name the unavailable decision");
      assert.equal(body["error"], "COSTKEY_POLICY_REFUSED", "refusal must use the typed policy error");
      ledger.addCheck(["F06", "DX09", "AC08"], "Unknown required price refusal", "pass", "local-http", `HTTP ${unknown.status}; typed refusal reason=${String(body["reason"])}`);
    }
  } catch (error) {
    ledger.addCheck(["F06", "DX09", "AC08"], "Unknown required price refusal", "fail", "local-http", error instanceof Error ? error.message : String(error));
  } finally {
    try {
      const removeMoney = await owner.request(`/api/v1/projects/${fixture.projectId}/budget/policies/${encodeURIComponent(moneyPolicyId)}`, { method: "DELETE" });
      expectStatus(removeMoney, 200, "archive unknown-price policy");
    } catch {
      // The disposable cluster is torn down after the run; do not hide the
      // substantive refusal result behind cleanup noise.
    }
  }

  let callsPolicyId: string | null = null;
  try {
    const callsPolicy = await owner.request(`/api/v1/projects/${fixture.projectId}/budget/policies`, {
      method: "POST",
      body: {
        name: "acceptance-concurrency",
        mode: "enforce",
        status: "active",
        unit: "calls",
        allowance: 1,
        window: "calendar_day",
        timezone: "UTC",
        periodStart: "activation",
        capabilityReview: { supported: true, admissionSupported: true, capabilityVersion: "acceptance/1", verified: true },
      },
    });
    if (callsPolicy.status === 404 || callsPolicy.status === 405) {
      ledger.recordNotImplemented(["F06", "DX09", "AC07", "AC09"], "Canonical spending policy route", `HTTP ${callsPolicy.status}; /api/v1/projects/:projectId/budget/policies is not mounted`);
      return;
    }
    expectStatus(callsPolicy, 201, "owner calls enforcement policy create");
    const callsBody = apiBody(callsPolicy, "owner calls enforcement policy create");
    callsPolicyId = typeof callsBody["id"] === "string" ? callsBody["id"] : null;
    assert.ok(callsPolicyId, "calls policy create must return an id");
    const callsDetail = await owner.request(`/api/v1/projects/${fixture.projectId}/budget/policies/${encodeURIComponent(callsPolicyId)}`);
    expectStatus(callsDetail, 200, "owner calls policy detail");
    const callsDetailBody = apiBody(callsDetail, "owner calls policy detail");
    const callsUsage = ((callsDetailBody["policy"] as Record<string, unknown> | undefined)?.["usage"] as Record<string, unknown> | undefined);
    if (callsUsage?.["remaining"] != null) {
      assert.equal(Number(callsUsage["remaining"]), 1, "new calls policy must start with one available allowance");
    }
    const usageRows = await pool.query<{ window_key: string; limit_quantity: number; reserved_quantity: number; settled_quantity: number; observed_quantity: number }>(
      `SELECT window_key, limit_quantity, reserved_quantity, settled_quantity, observed_quantity
       FROM policy_window_usage WHERE policy_id = $1`,
      [callsPolicyId],
    );
    assert.ok(usageRows.rows.every((row) => Number(row.limit_quantity) === 1 && Number(row.reserved_quantity) === 0 && Number(row.settled_quantity) === 0 && Number(row.observed_quantity) === 0), `new calls policy must start with empty usage rows; observed ${JSON.stringify(usageRows.rows)}`);
  } catch (error) {
    ledger.addCheck(["F06", "DX09", "AC07", "AC09"], "Shared admission policy setup", "fail", "local-http", error instanceof Error ? error.message : String(error));
    return;
  }

  try {
    const parallel = await Promise.all([
      request({ ...common, admissionId: "acceptance-concurrent-1", requestId: "acceptance-provider-concurrent-1", model: "gpt-4o", usageBounds: {} }),
      request({ ...common, admissionId: "acceptance-concurrent-2", requestId: "acceptance-provider-concurrent-2", model: "gpt-4o", usageBounds: {} }),
    ]);
    if (parallel.every((result) => result.status === 404 || result.status === 405)) {
      ledger.recordNotImplemented(["F06", "DX09", "AC07", "AC09"], "Canonical policy admission route", "No /api/v1/sdk/policy/admit response");
    } else {
      const decisions = parallel.map((result) => ({ result, body: apiBody(result, "parallel admission") }));
      const allowed = decisions.filter(({ body }) => body["decision"] === "allow");
      const refused = decisions.filter(({ body }) => body["decision"] === "refuse");
      const decisionSummary = decisions.map(({ result, body }) => ({ status: result.status, decision: body["decision"], reason: body["reason"], error: body["error"], policyId: body["policyId"], allowance: body["allowance"], keys: Object.keys(body) }));
      assert.equal(allowed.length, 1, `one shared calls allowance must admit exactly one concurrent request; observed ${JSON.stringify(decisionSummary)}`);
      assert.equal(refused.length, 1, `one shared calls allowance must refuse the second concurrent request; observed ${JSON.stringify(decisionSummary)}`);
      assert.equal(refused[0]?.body["reason"], "budget_exhausted", "second concurrent request must identify the refusing policy reason");
      const reservationId = allowed[0]?.body["reservationId"];
      assert.equal(typeof reservationId, "string", "allowed decision must return a reservation identity");

      const release = await dsn.request("/api/v1/sdk/policy/release", {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.projectKey}` },
        body: { reservationId, settlementId: "acceptance-release-1", outcome: "failed", providerAttempted: false },
      });
      expectStatus(release, 200, "explicit no-start release");
      const lateAdmission = await request({ ...common, admissionId: "acceptance-late-settlement", requestId: "acceptance-provider-late-settlement", model: "gpt-4o", usageBounds: {} });
      expectStatus(lateAdmission, 200, "late-settlement admission");
      const lateBody = apiBody(lateAdmission, "late-settlement admission");
      assert.equal(lateBody["decision"], "allow");
      const lateReservation = lateBody["reservationId"];
      assert.equal(typeof lateReservation, "string");
      const provisional = await dsn.request("/api/v1/sdk/policy/settle", {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.projectKey}` },
        body: { reservationId: lateReservation, settlementId: "acceptance-provisional", outcome: "unknown" },
      });
      expectStatus(provisional, 200, "provisional late settlement");
      const provisionalBody = apiBody(provisional, "provisional late settlement");
      assert.equal((provisionalBody["reservation"] as Record<string, unknown> | undefined)?.["state"], "unknown");
      const final = await dsn.request("/api/v1/sdk/policy/settle", {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.projectKey}` },
        body: { reservationId: lateReservation, settlementId: "acceptance-final", outcome: "success", actualCostUsd: 0, actualUsage: { totalTokens: 0 }, providerAttempted: true },
      });
      expectStatus(final, 200, "final late settlement");
      const finalBody = apiBody(final, "final late settlement");
      assert.equal((finalBody["reservation"] as Record<string, unknown> | undefined)?.["state"], "settled");
      const history = await owner.request(`/api/v1/projects/${fixture.projectId}/budget/policies/${encodeURIComponent(callsPolicyId)}/decisions`);
      expectStatus(history, 200, "policy decision history");
      const historyBody = apiBody(history, "policy decision history");
      const historyRows = historyBody["decisions"];
      assert.ok(Array.isArray(historyRows), "policy decision history must expose decisions");
      assert.ok(historyRows.some((row) => {
        const decision = row as Record<string, unknown>;
        return decision["decision"] === "refuse"
          && String(decision["policy_id"] ?? decision["policyId"] ?? "") === callsPolicyId;
      }), "policy decision history must identify the refusing policy");
      ledger.addCheck(["F06", "DX09", "AC07", "AC09"], "Shared admission, in-flight refusal, late settlement, and decision history", "pass", "local-http", "parallel requests yielded one allow and one budget_exhausted refusal; a not-started reservation was released, a later reservation moved unknown to settled, and decision history was durable");
    }
  } catch (error) {
    ledger.addCheck(["F06", "DX09", "AC07", "AC09"], "Shared admission, in-flight refusal, late settlement, and decision history", "fail", "local-http", error instanceof Error ? error.message : String(error));
  } finally {
    try {
      const removeCalls = await owner.request(`/api/v1/projects/${fixture.projectId}/budget/policies/${encodeURIComponent(callsPolicyId)}`, { method: "DELETE" });
      expectStatus(removeCalls, 200, "archive concurrency policy");
    } catch {
      // Disposable cleanup owns the final fallback; preserve substantive probe output.
    }
  }
}

interface PlannedRoute {
  ids: string[];
  label: string;
  method: string;
  path: string;
  body?: unknown;
  headers?: HeadersInit;
  expectMissing?: boolean;
}

async function runPlannedRouteProbes(
  ledger: EvidenceLedger,
  fixture: AcceptanceFixture,
  roles: RoleClients,
  baseUrl: string,
): Promise<void> {
  const base = `/api/v1/projects/${fixture.projectId}`;
  const routes: PlannedRoute[] = [
    { ids: ["F05"], label: "findings list", method: "GET", path: `${base}/findings` },
    { ids: ["F05"], label: "finding detail", method: "GET", path: `${base}/findings/finding_acceptance_missing`, expectMissing: true },
    { ids: ["F07", "DX05", "DX06", "AC10", "AC11"], label: "execution list", method: "GET", path: `${base}/executions` },
    { ids: ["F07", "DX05", "DX06", "AC10", "AC11"], label: "execution detail", method: "GET", path: `${base}/executions/execution_acceptance_missing`, expectMissing: true },
    { ids: ["F07", "AC10"], label: "group execution list", method: "GET", path: `${base}/groups/group_acceptance_missing/executions` },
    { ids: ["F09", "AC13"], label: "forecast", method: "GET", path: `${base}/forecast` },
    { ids: ["F09", "AC13"], label: "forecast calculate", method: "POST", path: `${base}/forecast`, body: { operations: 50_000, assumedCostPerOperation: 0.01 } },
    { ids: ["F09", "AC13"], label: "forecast scenario save", method: "POST", path: `${base}/forecast/scenarios`, body: { name: "acceptance-scenario", scope: {}, assumptions: { operations: 50_000, assumedCostPerOperation: 0.01 } } },
    { ids: ["F10", "AC14"], label: "credits list", method: "GET", path: `${base}/credits` },
    { ids: ["F10", "AC14"], label: "credits write", method: "POST", path: `${base}/credits`, body: { provider: "openai", accountScope: "acceptance-account", cloudProject: "acceptance", currency: "USD", originalAmount: 10, balanceAmount: 5, balanceAsOf: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), eligibility: { providers: ["openai"] } } },
  ];

  for (const route of routes) {
    let response: HttpResult<unknown>;
    try {
      response = await roles.owner.request(route.path, {
        method: route.method,
        body: route.body,
        headers: route.headers,
      });
    } catch (error) {
      ledger.addCheck(route.ids, route.label, "fail", "local-http", `request failed before response: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        ledger.addCheck(route.ids, route.label, "fail", "local-http", `HTTP ${response.status} redirect omitted a Location header`);
        continue;
      }
      try {
        const redirected = new URL(location, baseUrl);
        const origin = new URL(baseUrl).origin;
        if (redirected.origin !== origin) {
          ledger.addCheck(route.ids, route.label, "blocked", "local-http", "refused to follow a cross-origin redirect");
          continue;
        }
        response = await roles.owner.request(`${redirected.pathname}${redirected.search}`, { method: "GET" });
      } catch (error) {
        ledger.addCheck(route.ids, route.label, "fail", "local-http", `same-origin redirect failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    if (response.status === 404 && route.expectMissing) {
      ledger.addCheck(route.ids, route.label, "pass", "local-http", "known route returned the expected 404 for a nonexistent fixture ID", "smoke");
      continue;
    }
    if (response.status === 404 || response.status === 405) {
      ledger.recordNotImplemented(route.ids, route.label, `HTTP ${response.status}; the additive route is not implemented. Local fixture cannot stand in for the planned contract.`);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      ledger.addCheck(route.ids, route.label, "fail", "local-http", `HTTP ${response.status}: ${safeBody(response.body)}`);
      continue;
    }
    if (route.method === "GET") {
      if (!response.headers.get("content-type")?.includes("json")) {
        ledger.recordNotImplemented(route.ids, route.label, `HTTP ${response.status} returned ${response.headers.get("content-type") ?? "no content type"}; this is likely the SPA fallback, not a JSON API route.`);
        continue;
      }
      if (response.body === null) {
        ledger.addCheck(route.ids, route.label, "fail", "local-http", "HTTP 2xx JSON route returned an empty body");
        continue;
      }
    }
    ledger.addCheck(route.ids, route.label, "pass", "local-http", `HTTP ${response.status}; response shape was locally observable (route smoke only)`, "smoke");
  }

  await runFindingsProbe(ledger, fixture, roles);

  await ledger.recordCheck(
    ["F09", "AC13"],
    "Chosen-scale forecast assumptions",
    "local-http",
    async () => {
      const response = await roles.owner.request(`${base}/forecast`, {
        method: "POST",
        body: { operations: 50_000, assumedCostPerOperation: 0.01, currency: "USD" },
      });
      expectStatus(response, 200, "chosen-scale forecast");
      const body = apiBody(response, "chosen-scale forecast");
      const forecast = body["forecast"] as Record<string, unknown> | undefined;
      const chosen = forecast?.["chosenScale"] as Record<string, unknown> | undefined;
      assert.equal(chosen?.["operations"], 50_000, "forecast must preserve operation units");
      assert.equal(chosen?.["costPerOperation"], 0.01, "manual forecast must preserve assumed unit cost");
      assert.equal(chosen?.["projectedCost"], 500, "forecast must calculate operations x assumed unit cost");
      assert.equal(chosen?.["automatic"], false, "small fixture must not pretend to have an automatic baseline");
      return "50,000-operation manual forecast reproduced $500 from explicit assumptions without a provider call";
    },
  );

  await ledger.recordCheck(
    ["F10", "AC14"],
    "Credit provenance and consumption independence",
    "local-http",
    async () => {
      const before = await roles.owner.request(`${base}/events?limit=200`);
      expectStatus(before, 200, "events before credit");
      const beforeBody = apiBody(before, "events before credit");
      const beforeEvents = beforeBody["events"];
      assert.ok(Array.isArray(beforeEvents));
      const beforeKnown = beforeEvents.reduce((sum, event) => {
        const cost = Number((event as Record<string, unknown>)["cost_usd"] ?? (event as Record<string, unknown>)["costUsd"]);
        return Number.isFinite(cost) ? sum + cost : sum;
      }, 0);

      const credits = await roles.owner.request(`${base}/credits`);
      expectStatus(credits, 200, "credit list");
      const creditsBody = apiBody(credits, "credit list");
      const rows = creditsBody["credits"];
      assert.ok(Array.isArray(rows), "credit list must expose credits array");
      assert.ok(rows.some((row) => (row as Record<string, unknown>)["source"] === "user_supplied"), "manual credit must retain user-supplied provenance");

      const after = await roles.owner.request(`${base}/events?limit=200`);
      expectStatus(after, 200, "events after credit");
      const afterBody = apiBody(after, "events after credit");
      const afterEvents = afterBody["events"];
      assert.ok(Array.isArray(afterEvents));
      const afterKnown = afterEvents.reduce((sum, event) => {
        const cost = Number((event as Record<string, unknown>)["cost_usd"] ?? (event as Record<string, unknown>)["costUsd"]);
        return Number.isFinite(cost) ? sum + cost : sum;
      }, 0);
      assert.equal(afterEvents.length, beforeEvents.length, "credit entry must not add billable event rows");
      assert.equal(afterKnown, beforeKnown, "credit entry must not change observed consumption totals");
      return `manual credit provenance was visible; ${afterEvents.length} observed calls and $${afterKnown.toFixed(6)} known cost were unchanged`;
    },
  );
}

async function runFindingsProbe(
  ledger: EvidenceLedger,
  fixture: AcceptanceFixture,
  roles: RoleClients,
): Promise<void> {
  await ledger.recordCheck(
    ["F05"],
    "Finding evidence and chronology",
    "local-http",
    async () => {
      const list = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/findings`);
      expectStatus(list, 200, "finding list");
      const listBody = apiBody(list, "finding list");
      const rows = listBody["findings"];
      assert.ok(Array.isArray(rows), "finding list must expose findings array");
      const row = rows.find((candidate) => String((candidate as Record<string, unknown>)["id"] ?? "") === "finding_acceptance_coverage") as Record<string, unknown> | undefined;
      assert.ok(row, "finding list must include the deterministic local coverage finding");
      assert.equal(row["family"], "pricing_coverage");
      assert.ok(typeof row["observedAt"] === "string" && typeof row["lastSeenAt"] === "string", "finding must preserve chronology timestamps");
      assert.ok(row["evidence"] && typeof row["evidence"] === "object", "finding must expose structured evidence");
      assert.ok(Array.isArray(row["nextActions"]), "finding must expose next actions");
      assert.equal(JSON.stringify(row).includes("confidence"), false, "local finding must not invent confidence percentages");

      const detail = await roles.owner.request(`/api/v1/projects/${fixture.projectId}/findings/finding_acceptance_coverage`);
      expectStatus(detail, 200, "finding detail");
      const detailBody = apiBody(detail, "finding detail");
      assert.equal((detailBody["finding"] as Record<string, unknown> | undefined)?.["id"], "finding_acceptance_coverage");
      return "finding list/detail preserved family, chronology, structured evidence, and next actions without confidence claims";
    },
  );
}

function localOutcomeSummary(records: EvidenceRecord[]): Record<LocalOutcome | "incomplete", number> {
  const summary: Record<LocalOutcome | "incomplete", number> = {
    pass: 0,
    fail: 0,
    "not-implemented": 0,
    blocked: 0,
    "not-run": 0,
    "smoke-only": 0,
    incomplete: 0,
  };
  for (const record of records) {
    summary[record.localOutcome]++;
    summary.incomplete++;
  }
  return summary;
}

function renderRecords(records: EvidenceRecord[]): string {
  const lines = [
    "| ID | Full target status | Local outcome | Local verification | Checks | Required proof |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const record of records) {
    const checks = record.checks.length === 0
      ? "not run"
      : record.checks.map((check) => `${check.outcome}${check.kind === "smoke" ? "[smoke]" : ""}: ${check.label}`).join("; ");
    lines.push(
      `| ${record.id} | INCOMPLETE | ${record.localOutcome} | ${record.localVerification} | ${checks.replaceAll("|", "\\|")} | ${record.requiredProof.join(", ")} |`,
    );
  }
  return lines.join("\n");
}

function renderEvidenceMarkdown(report: EvidenceReport): string {
  const summary = report.summary;
  const capabilities = report.capabilities;
  const scenarios = report.acceptanceScenarios;
  return [
    "# CostKey local acceptance evidence",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Proof boundary: ${report.proofBoundary}`,
    "",
    `Environment: ${report.environment.baseUrl}; PostgreSQL ${report.environment.databaseHost}/${report.environment.databaseName}; external delivery ${report.environment.externalDelivery}; network guard ${report.environment.networkGuard}; provider network ${report.environment.providerNetwork}.`,
    "",
    `Summary: ${summary.pass} local pass, ${summary.fail} local fail, ${summary["not-implemented"]} not implemented, ${summary.blocked} blocked, ${summary["smoke-only"]} smoke-only, ${summary["not-run"]} not run; ${summary.incomplete} full target items remain INCOMPLETE pending required proof.`,
    "",
    "## Capabilities (F01-F12, DX01-DX10)",
    "",
    renderRecords(capabilities),
    "",
    "## Acceptance scenarios (AC01-AC20)",
    "",
    renderRecords(scenarios),
    "",
    "## Failure-path budget",
    "",
    "The local run covers a bounded set of high-consequence seams. It does not simulate provider billing, outbound email/webhooks, device behavior, or production deployment.",
    "",
    ...report.failurePaths.flatMap((failure) => [
      `### ${failure.id} — ${failure.title}`,
      "",
      `Given: ${failure.given} When: ${failure.when} Then: ${failure.then} Recovery: ${failure.recovery} Proof: ${failure.proof}`,
      "",
    ]),
  ].join("\n");
}

async function writeReport(config: LocalConfig, ledger: EvidenceLedger): Promise<EvidenceReport> {
  const records = ledger.values();
  const capabilityIds = new Set(CAPABILITIES.map((item) => item.id));
  const report: EvidenceReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    proofBoundary: "Local CostKey HTTP server + isolated PostgreSQL + deterministic synthetic fixtures. A local pass is not representative-provider, deployed, email/webhook, device, or browser proof.",
    environment: {
      baseUrl: config.baseUrl,
      ...databaseEvidence(config.databaseUrl),
      externalDelivery: "disabled",
      networkGuard: "loopback-only",
      providerNetwork: "not-used",
      fixtureBoundary: "synthetic-local-only",
    },
    summary: localOutcomeSummary(records),
    capabilities: records.filter((record) => capabilityIds.has(record.id)),
    acceptanceScenarios: records.filter((record) => !capabilityIds.has(record.id)),
    failurePaths: FAILURE_PATHS,
  };

  await mkdir(path.dirname(config.reportPath), { recursive: true });
  await writeFile(config.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownPath = config.reportPath.replace(/\.json$/i, ".md");
  await writeFile(markdownPath, `${renderEvidenceMarkdown(report)}\n`, "utf8");
  return report;
}

async function main(): Promise<void> {
  const config = localConfig();
  const ledger = new EvidenceLedger();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 4,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 5_000,
  });

  let report: EvidenceReport | null = null;
  try {
    await runNetworkBoundaryProbe(ledger);
    await waitForServer(config.baseUrl, pool);
    const fixture = await seedAcceptanceFixtures(pool);
    const roles = await createRoleClients(config.baseUrl);

    if (fixture.platformSchemaBootstrapped) {
      ledger.recordBlocked(
        ["F12", "DX10", "AC19"],
        "Platform schema startup hook",
        "Server reached Ready without project_settings/project_memberships; the local fixture created a minimal compatibility schema. Wire ensurePlatformSchema into application startup before treating role/settings evidence as valid.",
      );
    } else {
      ledger.addCheck(
        ["F12", "DX10", "AC19"],
        "Platform schema startup hook",
        "pass",
        "local-http",
        "Server startup provided project_settings/project_memberships before fixture setup",
      );
    }

    await runPhase(ledger, ["F01", "DX01", "DX02", "DX03", "DX04", "DX07", "AC01", "AC02"], "SDK HTTP probe", () => runSdkHttpProbe(ledger, pool, fixture, config.baseUrl));
    await runPhase(ledger, ["F12", "DX01", "DX02", "AC01", "AC19"], "TypeScript privacy transition probe", () => runTypeScriptPrivacyTransitionProbe(ledger, pool, fixture, roles, config.baseUrl));
    await runPhase(ledger, ["F01", "DX01", "DX10", "AC01"], "DSN config probe", () => runDsnConfigProbe(ledger, fixture, config.baseUrl));
    await runPhase(ledger, ["F08", "DX08", "AC12"], "SDK usage probe", () => runSdkUsageProbe(ledger, pool, fixture, config.baseUrl));
    await runPhase(ledger, ["F08", "DX08", "AC12"], "Python SDK usage probe", () => runPythonSdkUsageProbe(ledger, pool, fixture, config.baseUrl));
    await runPhase(ledger, ["F12", "DX01", "DX02", "AC01", "AC02"], "Python privacy transition probe", () => runPythonPrivacyTransitionProbe(ledger, pool, fixture, roles, config.baseUrl));
    await runPhase(ledger, ["F07", "DX05", "DX06", "DX07", "AC10", "AC11"], "SDK lifecycle probe", () => runSdkLifecycleProbe(ledger, pool, fixture, config.baseUrl));
    await runPhase(ledger, ["F01", "F02", "F03", "F04", "DX01", "DX02", "DX07", "DX10", "AC01", "AC02", "AC03", "AC04", "AC05", "AC06", "AC16", "AC17"], "ingest/trace probes", () => runIngestAndTraceProbes(ledger, pool, fixture, roles, config.baseUrl));
    await runPhase(ledger, ["F01", "F02", "DX01", "DX07", "AC01", "AC02", "AC17"], "project-scoped event identity probe", () => runProjectScopedEventIdProbe(ledger, pool, fixture, config.baseUrl));
    await runPhase(ledger, ["F03", "F12", "DX02", "AC03", "AC15"], "feature mapping probes", () => runFeatureMappingProbe(ledger, pool, fixture, roles, config.baseUrl));
    await runPhase(ledger, ["F02", "F11", "F12", "DX10", "AC06", "AC15", "AC18", "AC19"], "role/export probes", () => runRoleAndExportProbes(ledger, pool, fixture, roles));
    await runPhase(ledger, ["F03", "F11", "F12", "AC03", "AC15", "AC18"], "filter/export cohort probe", () => runFilterAndFullExportProbe(ledger, pool, fixture, roles));
    await runPhase(ledger, ["F09", "F11", "F12", "DX10", "AC13", "AC15", "AC19"], "saved-view and forecast privacy probes", () => runSavedViewAndForecastPrivacyProbe(ledger, fixture, roles, config.baseUrl));
    await runPhase(ledger, ["F11", "F12", "DX10", "AC15", "AC20"], "notification delivery acceptance probe", () => runNotificationAcceptanceProbe(ledger, pool, fixture, roles));
    await runPhase(ledger, ["F04", "F12"], "historical aggregate retention probe", () => runHistoricalAggregateRetentionProbe(ledger, pool, fixture));
    await runPhase(ledger, ["F06", "DX09", "AC07", "AC08", "AC09"], "policy/failure probes", () => runBudgetAndFailureProbes(ledger, pool, fixture, roles, config.baseUrl));
    await runPhase(ledger, ["F05", "F07", "F08", "F09", "F10", "DX03", "DX05", "DX06", "DX07", "DX08", "DX10", "AC10", "AC11", "AC12", "AC13", "AC14", "AC20"], "planned route probes", () => runPlannedRouteProbes(ledger, fixture, roles, config.baseUrl));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ledger.recordBlocked(ALL_CATALOG_IDS, "Harness setup/phase failure", detail);
    console.error(`[acceptance] probe run did not complete: ${detail}`);
  } finally {
    try {
      report = await writeReport(config, ledger);
      const summary = report.summary;
      console.log(`[acceptance] report: ${config.reportPath}`);
      console.log(`[acceptance] local pass=${summary.pass} fail=${summary.fail} not-implemented=${summary["not-implemented"]} blocked=${summary.blocked} smoke-only=${summary["smoke-only"]}`);
      console.log(`[acceptance] full target status: ${summary.incomplete} catalog items remain INCOMPLETE until required proof is recorded`);
      if (config.strict && (summary.fail > 0 || summary.blocked > 0 || summary["not-implemented"] > 0 || summary["not-run"] > 0)) {
        process.exitCode = 1;
      }
    } finally {
      await pool.end();
    }
  }
}

async function runPhase(
  ledger: EvidenceLedger,
  ids: readonly string[],
  label: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ledger.recordBlocked(ids, label, `Phase aborted after an unexpected harness error: ${detail}`);
  }
}

void main().catch((error: unknown) => {
  console.error(`[acceptance] harness error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
