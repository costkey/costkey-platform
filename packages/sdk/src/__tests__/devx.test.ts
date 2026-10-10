import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import {
  CostKey,
  CostKeyPolicyRefused,
  Provider,
  UsageConflictError,
  recordLiveKitUsage,
} from "../index.js";
import { registerExtractor } from "../providers/registry.js";
import type { ProviderExtractor } from "../types.js";

interface CapturedPayload {
  events: Array<Record<string, unknown>>;
}

function runtimeConfig(projectId: string, mode: "metadata" | "text", bodyCaptureEnabled: boolean) {
  return {
    projectId,
    capture: {
      mode,
      bodyCaptureEnabled,
      redactionEnabled: true,
      bodyRetentionDays: 7,
      metadataRetentionDays: 30,
    },
    providers: [],
  };
}

async function waitUntil(check: () => boolean, timeoutMs = 250): Promise<void> {
  const started = Date.now();
  while (!check() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function settleRuntimeConfig(): Promise<void> {
  // The config counter is incremented when fetch starts; allow response.json()
  // and the SDK's ref update to run before the next provider call.
  await new Promise((resolve) => setTimeout(resolve, 2));
}

const fakeProvider: ProviderExtractor = {
  provider: Provider.Unknown,
  match(url) {
    return url.hostname === "127.0.0.1" && url.pathname === "/fake-provider";
  },
  extractUsage(body) {
    if (!body || typeof body !== "object") return null;
    const usage = (body as Record<string, unknown>)["usage"];
    if (!usage || typeof usage !== "object") return null;
    const values = usage as Record<string, unknown>;
    const inputTokens = typeof values["input_tokens"] === "number" ? values["input_tokens"] : null;
    const outputTokens = typeof values["output_tokens"] === "number" ? values["output_tokens"] : null;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    };
  },
  extractModel(requestBody, responseBody) {
    for (const body of [responseBody, requestBody]) {
      if (!body || typeof body !== "object") continue;
      const model = (body as Record<string, unknown>)["model"];
      if (typeof model === "string") return model;
    }
    return null;
  },
};

registerExtractor(fakeProvider);

describe("CostKey developer experience", () => {
  let originalFetch: typeof globalThis.fetch;
  let provider: Server;
  let providerUrl: string;
  let payloads: CapturedPayload[];

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    payloads = [];
    provider = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        id: "fake-provider-request-1",
        model: "fake-model",
        usage: { input_tokens: 3, output_tokens: 2 },
      }));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("fake provider did not bind");
    providerUrl = `http://127.0.0.1:${address.port}/fake-provider`;

    // The provider is a real local HTTP endpoint. Ingest is a deterministic
    // local transport stub so this test never contacts CostKey production.
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://costkey.dev/api/v1/events") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as CapturedPayload : { events: [] };
        payloads.push(body);
        return new Response(JSON.stringify({ accepted: body.events.length }), { status: 202 });
      }
      return originalFetch(input, init);
    };
  });

  afterEach(async () => {
    await CostKey.shutdown();
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });

  it("captures a local provider call and emits explicit trace lifecycle records", async () => {
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/devx-test",
      captureBody: false,
      maxBatchSize: 100,
    });

    await CostKey.startTrace({ name: "search" }, async () => {
      const response = await fetch(providerUrl, {
        method: "POST",
        body: JSON.stringify({ model: "fake-model" }),
      });
      expect(response.status).toBe(200);
    });
    await CostKey.flush();

    const events = payloads.flatMap((payload) => payload.events);
    const lifecycle = events.filter((event) => event["eventType"] === "lifecycle");
    const calls = events.filter((event) => event["eventType"] === "call");
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle.map((event) => event["lifecycle"])).toEqual(["started", "completed"]);
    expect(lifecycle.map((event) => event["sequence"])).toEqual([0, 1]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.["providerRequestId"]).toBe("fake-provider-request-1");
    expect((calls[0]?.["context"] as Record<string, unknown>)["traceId"]).toBe(
      (lifecycle[0]?.["context"] as Record<string, unknown>)["traceId"],
    );
  });

  it("sanitizes provider URL credentials and query secrets before telemetry", async () => {
    const credentialedUrl = providerUrl.replace(
      "http://",
      "http://provider-user:provider-password@",
    ) + "?key=provider-secret&access_token=another-secret#fragment";
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === credentialedUrl) {
        return new Response(JSON.stringify({
          id: "credentialed-provider-request",
          model: "fake-model",
          usage: { input_tokens: 3, output_tokens: 2 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return previousFetch(input, init);
    };
    // Initialize after the shim so the SDK wraps this deterministic provider.
    await CostKey.shutdown();
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/url-sanitize-test",
      captureBody: false,
      maxBatchSize: 100,
    });
    await fetch(credentialedUrl, { method: "POST", body: "{}" });
    await CostKey.flush();

    const events = payloads.flatMap((payload) => payload.events);
    const call = events.find((event) => event["eventType"] === "call");
    expect(String(call?.["url"])).toBe(providerUrl);
    expect(JSON.stringify(call)).not.toContain("provider-secret");
    expect(JSON.stringify(call)).not.toContain("provider-password");
  });

  it("keeps prompt metadata and system instructions off the wire in metadata-only mode", async () => {
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/metadata-wire-test",
      captureBody: false,
      maxBatchSize: 100,
    });
    await fetch(providerUrl, {
      method: "POST",
      body: JSON.stringify({
        model: "fake-model",
        system: "system-secret-that-must-not-leave-the-process",
        messages: [{ role: "user", content: "prompt-secret-that-must-not-leave-the-process" }],
        tools: [{ type: "function", function: { description: "tool-secret" } }],
      }),
    });
    await CostKey.flush();

    const call = payloads
      .flatMap((payload) => payload.events)
      .find((event) => event["eventType"] === "call");
    expect(call?.["requestBody"]).toBeNull();
    expect(call?.["responseBody"]).toBeNull();
    expect(call?.["systemPrompt"]).toBeNull();
    const wire = JSON.stringify(call);
    expect(wire).not.toContain("system-secret-that-must-not-leave-the-process");
    expect(wire).not.toContain("prompt-secret-that-must-not-leave-the-process");
    expect(wire).not.toContain("tool-secret");
    expect((call?.["metadata"] as Record<string, unknown>)?.["raw"]).toEqual({
      promptCount: 1,
      promptRoles: ["user"],
      toolDefinitionCount: 1,
    });
  });

  it("starts metadata-safe while config is delayed, then adopts remote text capture", async () => {
    let releaseConfig!: (response: Response) => void;
    const delayedConfig = new Promise<Response>((resolve) => { releaseConfig = resolve; });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://costkey.dev/api/v1/projects/delayed-config/config") return delayedConfig;
      return previousFetch(input, init);
    };
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/delayed-config",
      captureBody: true,
      maxBatchSize: 100,
    });

    await fetch(`${providerUrl}?key=delayed-url-secret`, {
      method: "POST",
      body: JSON.stringify({ model: "fake-model", prompt: "private-before-config" }),
    });
    await CostKey.flush();
    let calls = payloads.flatMap((payload) => payload.events).filter((event) => event["eventType"] === "call");
    expect(calls[0]?.["requestBody"]).toBeNull();
    expect(calls[0]?.["responseBody"]).toBeNull();
    expect(JSON.stringify(calls[0])).not.toContain("delayed-url-secret");
    expect(JSON.stringify(calls[0])).not.toContain("private-before-config");

    releaseConfig(new Response(JSON.stringify(runtimeConfig("delayed-config", "text", true)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await settleRuntimeConfig();
    await fetch(providerUrl, {
      method: "POST",
      body: JSON.stringify({ model: "fake-model", prompt: "private-after-config" }),
    });
    await CostKey.flush();
    calls = payloads.flatMap((payload) => payload.events).filter((event) => event["eventType"] === "call");
    expect(calls[1]?.["requestBody"]).not.toBeNull();
    expect(JSON.stringify(calls[1])).toContain("private-after-config");
  });

  it("fails closed to metadata-only when runtime config is missing", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://costkey.dev/api/v1/projects/missing-config/config") {
        throw new Error("config unavailable");
      }
      return previousFetch(input, init);
    };
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/missing-config",
      captureBody: true,
      maxBatchSize: 100,
    });
    await fetch(providerUrl, {
      method: "POST",
      body: JSON.stringify({ model: "fake-model", prompt: "private-missing-config" }),
    });
    await CostKey.flush();
    const calls = payloads.flatMap((payload) => payload.events).filter((event) => event["eventType"] === "call");
    expect(calls[0]?.["requestBody"]).toBeNull();
    expect(calls[0]?.["responseBody"]).toBeNull();
  });

  it("lets remote metadata revocation override local text capture", async () => {
    let configRequests = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://costkey.dev/api/v1/projects/revocation-config/config") {
        configRequests++;
        const config = configRequests === 1
          ? runtimeConfig("revocation-config", "text", true)
          : runtimeConfig("revocation-config", "metadata", false);
        return new Response(JSON.stringify(config), { status: 200 });
      }
      return previousFetch(input, init);
    };
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/revocation-config",
      captureBody: true,
      configRefreshInterval: 20,
      maxBatchSize: 100,
    });
    await waitUntil(() => configRequests >= 1);
    await settleRuntimeConfig();
    await fetch(providerUrl, {
      method: "POST",
      body: JSON.stringify({ model: "fake-model", prompt: "allowed-before-revocation" }),
    });
    await CostKey.flush();
    await waitUntil(() => configRequests >= 2);
    await settleRuntimeConfig();
    await fetch(providerUrl, {
      method: "POST",
      body: JSON.stringify({ model: "fake-model", prompt: "blocked-after-revocation" }),
    });
    await CostKey.flush();
    const calls = payloads.flatMap((payload) => payload.events).filter((event) => event["eventType"] === "call");
    expect(calls[0]?.["requestBody"]).not.toBeNull();
    expect(calls[1]?.["requestBody"]).toBeNull();
  });

  it("keeps an explicit local captureBody false stronger than remote text capture and still redacts when enabled", async () => {
    let configRequests = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://costkey.dev/api/v1/projects/local-off-config/config") {
        configRequests++;
        return new Response(JSON.stringify(runtimeConfig("local-off-config", "text", true)), { status: 200 });
      }
      return previousFetch(input, init);
    };
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/local-off-config",
      captureBody: false,
      maxBatchSize: 100,
    });
    await waitUntil(() => configRequests >= 1);
    await settleRuntimeConfig();
    await fetch(providerUrl, {
      method: "POST",
      body: JSON.stringify({ model: "fake-model", prompt: "local-opt-out" }),
    });
    await CostKey.flush();
    let calls = payloads.flatMap((payload) => payload.events).filter((event) => event["eventType"] === "call");
    expect(calls[0]?.["requestBody"]).toBeNull();

    await CostKey.shutdown();
    configRequests = 0;
    const redactionFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://costkey.dev/api/v1/projects/redaction-config/config") {
        configRequests++;
        return new Response(JSON.stringify(runtimeConfig("redaction-config", "text", true)), { status: 200 });
      }
      return redactionFetch(input, init);
    };
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/redaction-config",
      captureBody: true,
      maxBatchSize: 100,
    });
    await waitUntil(() => configRequests >= 1);
    await settleRuntimeConfig();
    const secret = `sk-${"a".repeat(32)}`;
    await fetch(providerUrl, {
      method: "POST",
      body: JSON.stringify({ model: "fake-model", api_key: secret, prompt: "redacted" }),
    });
    await CostKey.flush();
    calls = payloads.flatMap((payload) => payload.events).filter((event) => event["eventType"] === "call");
    expect(calls[0]?.["requestBody"]).toBeNull();
    expect(JSON.stringify(calls.at(-1))).not.toContain(secret);
    expect(JSON.stringify(calls.at(-1))).toContain("[REDACTED]");
  });

  it("keeps concurrent traces independent even when they call the same function", async () => {
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/concurrent-test",
      captureBody: false,
      maxBatchSize: 100,
    });

    const invoke = async () => {
      await CostKey.startTrace({ name: "same-function" }, async () => {
        await fetch(providerUrl, { method: "POST", body: "{}" });
      });
    };
    await Promise.all([invoke(), invoke()]);
    await CostKey.flush();

    const events = payloads.flatMap((payload) => payload.events);
    const starts = events.filter(
      (event) => event["eventType"] === "lifecycle" && event["lifecycle"] === "started",
    );
    const calls = events.filter((event) => event["eventType"] === "call");
    const traceIds = new Set(
      calls.map((event) => (event["context"] as Record<string, unknown>)["traceId"]),
    );
    expect(starts).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(traceIds.size).toBe(2);
  });

  it("preserves explicit attempt and retry-parent metadata without inferring relationships", async () => {
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/attempt-relationship-test",
      captureBody: false,
      maxBatchSize: 100,
    });

    await CostKey.withContext({
      attemptId: "attempt-fallback-2",
      parentEventId: "attempt-primary-1",
      conversationId: "conversation-1",
      voiceSessionId: "voice-1",
    }, async () => {
      await fetch(providerUrl, { method: "POST", body: "{}" });
    });
    await fetch(providerUrl, { method: "POST", body: "{}" });
    await CostKey.flush();

    const calls = payloads
      .flatMap((payload) => payload.events)
      .filter((event) => event["eventType"] === "call");
    const call = calls[0];
    expect(call?.["id"]).toBe("attempt-fallback-2");
    expect(call?.["attemptId"]).toBe("attempt-fallback-2");
    expect(call?.["parentEventId"]).toBe("attempt-primary-1");
    expect((call?.["context"] as Record<string, unknown>)["conversationId"]).toBe("conversation-1");
    expect((call?.["context"] as Record<string, unknown>)["voiceSessionId"]).toBe("voice-1");
    expect(calls[1]?.["parentEventId"]).toBeNull();
    expect(calls[1]?.["attemptId"]).not.toBe(call?.["attemptId"]);
  });

  it("gives repeatable grouped work fresh executions and carries execution context to member traces", async () => {
    const additive: Array<Record<string, unknown>> = [];
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/execution-test",
      captureBody: false,
      maxBatchSize: 100,
      beforeSendEvent(event) {
        additive.push(event as unknown as Record<string, unknown>);
        return event;
      },
    });

    const executionIds: string[] = [];
    for (let run = 0; run < 2; run++) {
      await CostKey.startExecution(
        {
          name: "nightly-document-import",
          kind: "batch",
          expectedItems: 1,
          configuration: { variant: "stable" },
        },
        async () => {
          const executionId = CostKey.getCurrentContext().executionId;
          if (!executionId) throw new Error("missing execution context");
          executionIds.push(executionId);
          await CostKey.startTrace({ name: `document-${run}` }, async () => {
            await fetch(providerUrl, { method: "POST", body: "{}" });
          });
        },
      );
    }
    await CostKey.flush();

    expect(new Set(executionIds).size).toBe(2);
    const executionLifecycle = additive.filter(
      (event) => event["eventType"] === "lifecycle" && event["entityType"] === "execution",
    );
    expect(executionLifecycle).toHaveLength(4);
    expect(executionLifecycle.filter((event) => event["lifecycle"] === "started")).toHaveLength(2);
    expect(executionLifecycle.every((event) => event["groupName"] === "nightly-document-import")).toBe(true);
    expect(executionLifecycle.every((event) => event["groupKind"] === "batch")).toBe(true);
    const callEvents = additive.filter((event) => event["eventType"] === "lifecycle" && event["entityType"] === "trace");
    expect(callEvents).toHaveLength(4);
    expect(callEvents.every((event) => executionIds.includes(String((event["context"] as Record<string, unknown>)["executionId"])))).toBe(true);
    const providerCalls = payloads
      .flatMap((payload) => payload.events)
      .filter((event) => event["eventType"] === "call");
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls.every((event) => executionIds.includes(String(event["executionId"])))).toBe(true);
  });

  it("does not add CostKey context headers to arbitrary HTTP destinations", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const passthrough = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, headers: new Headers(init?.headers) });
      return new Response("ok", { status: 200 });
    };
    CostKey.init({ dsn: "https://ck_test@costkey.dev/header-test", captureBody: false });

    await CostKey.withContext({ traceId: "trace-explicit", traceName: "search" }, async () => {
      await fetch("https://api.example.test/ordinary", { method: "GET" });
    });

    const ordinaryRequests = requests.filter(({ url }) => url === "https://api.example.test/ordinary");
    expect(ordinaryRequests).toHaveLength(1);
    expect(ordinaryRequests[0]?.headers.has("x-costkey-trace-id")).toBe(false);
    expect(ordinaryRequests[0]?.headers.has("x-costkey-trace-name")).toBe(false);
    expect(ordinaryRequests[0]?.headers.has("x-costkey-context")).toBe(false);
    globalThis.fetch = passthrough;
  });

  it("accepts an explicitly supplied carrier on a provider request without forwarding CostKey headers", async () => {
    const providerRequests: Array<{ headers: Headers }> = [];
    const passthrough = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === providerUrl) {
        providerRequests.push({ headers: new Headers(init?.headers) });
      }
      return passthrough(input, init);
    };
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/carrier-provider-test",
      captureBody: false,
      maxBatchSize: 100,
    });

    const carrier = JSON.stringify({
      traceId: "trace-from-upstream",
      traceName: "upstream-operation",
      privateLabel: "not-allowed",
    });
    await fetch(providerUrl, {
      method: "POST",
      headers: { "x-costkey-context": carrier },
      body: "{}",
    });
    await CostKey.flush();

    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.headers.has("x-costkey-context")).toBe(false);
    const calls = payloads
      .flatMap((payload) => payload.events)
      .filter((event) => event["eventType"] === "call");
    expect((calls[0]?.["context"] as Record<string, unknown>)["traceId"]).toBe("trace-from-upstream");
    expect((calls[0]?.["context"] as Record<string, unknown>)["privateLabel"]).toBeUndefined();
  });

  it("sanitizes carriers from a Request even when fetch receives a separate init", async () => {
    const providerHeaders: Headers[] = [];
    const passthrough = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === providerUrl) {
        providerHeaders.push(input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers));
      }
      return passthrough(input, init);
    };
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/request-carrier-test",
      captureBody: false,
      maxBatchSize: 100,
    });
    const carrier = JSON.stringify({ traceId: "trace-request-carrier", traceName: "request-boundary" });
    const request = new Request(providerUrl, {
      method: "POST",
      headers: { "x-costkey-context": carrier },
      body: "{}",
    });
    await fetch(request, { method: "POST" });
    await CostKey.flush();

    expect(providerHeaders).toHaveLength(1);
    expect(providerHeaders[0]?.has("x-costkey-context")).toBe(false);
    const call = payloads
      .flatMap((payload) => payload.events)
      .find((event) => event["eventType"] === "call");
    expect((call?.["context"] as Record<string, unknown>)["traceId"]).toBe("trace-request-carrier");
  });

  it("uses the explicit DSN policy endpoint for admission and settles actual usage", async () => {
    const admissions: Array<Record<string, unknown>> = [];
    const settlements: Array<Record<string, unknown>> = [];
    let settlementAttempt = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://costkey.dev/api/v1/sdk/policy/admit") {
        admissions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          decision: "allow",
          replay: false,
          providerCallAllowed: true,
          reservationId: "reservation-1",
        }), { status: 200 });
      }
      if (url === "https://costkey.dev/api/v1/sdk/policy/settle") {
        settlements.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        settlementAttempt++;
        // First response forces the SDK's unknown-settlement fallback, which
        // preserves the reservation when a verified actual amount is absent.
        return settlementAttempt === 1
          ? new Response(JSON.stringify({ error: "temporary" }), { status: 503 })
          : new Response(JSON.stringify({ state: "unknown" }), { status: 200 });
      }
      return previousFetch(input, init);
    };

    CostKey.init({
      dsn: "https://ck_test@costkey.dev/policy-test",
      captureBody: false,
      maxBatchSize: 100,
      policy: {
        mode: "enforce",
        integration: {
          supported: true,
          admissionSupported: true,
          capabilityVersion: "test-v1",
          verified: true,
        },
      },
    });
    await CostKey.withContext({ feature: "search", policySecret: "do-not-send" }, () =>
      CostKey.startTrace({ name: "policy-trace" }, async () => {
        await fetch(providerUrl, { method: "POST", body: JSON.stringify({ model: "fake-model" }) });
      }),
    );
    await CostKey.flush();

    expect(admissions).toHaveLength(1);
    expect(admissions[0]?.["admissionId"]).toBe(admissions[0]?.["requestId"]);
    expect(admissions[0]?.["provider"]).toBe("unknown");
    expect(admissions[0]).not.toHaveProperty("requestBody");
    expect(admissions[0]).not.toHaveProperty("providerRequest");
    expect((admissions[0]?.["context"] as Record<string, unknown>)["policySecret"]).toBeUndefined();
    expect((admissions[0]?.["integration"] as Record<string, unknown>)["verified"]).toBe(true);
    expect(settlements).toHaveLength(2);
    expect(settlements[0]?.["outcome"]).toBe("success");
    expect(settlements[1]?.["outcome"]).toBe("unknown");
    expect((settlements[0]?.["actualUsage"] as Record<string, unknown>)["totalTokens"]).toBe(5);
  });

  it("turns an explicit enforced refusal into a typed error before the provider runs", async () => {
    let providerCalls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://costkey.dev/api/v1/sdk/policy/admit") {
        return new Response(JSON.stringify({
          decision: "refuse",
          reason: "budget_exhausted",
          policyId: "daily-cap",
          message: "The shared allowance is exhausted",
        }), { status: 429 });
      }
      if (url === providerUrl) providerCalls++;
      return previousFetch(input, init);
    };
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/policy-refusal",
      captureBody: false,
      policy: { mode: "enforce" },
    });

    await expect(
      fetch(providerUrl, { method: "POST", body: JSON.stringify({ model: "fake-model" }) }),
    ).rejects.toBeInstanceOf(CostKeyPolicyRefused);
    try {
      await fetch(providerUrl, { method: "POST", body: JSON.stringify({ model: "fake-model" }) });
    } catch (error) {
      expect(error).toMatchObject({ reason: "budget_exhausted", policyId: "daily-cap" });
    }
    expect(providerCalls).toBe(0);
  });

  it("keeps monitor-mode admission fail-open when its decision endpoint is unavailable", async () => {
    let providerCalls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://costkey.dev/api/v1/sdk/policy/admit") {
        throw new Error("policy endpoint unavailable");
      }
      if (url === providerUrl) providerCalls++;
      return previousFetch(input, init);
    };
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/policy-monitor",
      captureBody: false,
      maxBatchSize: 100,
      policy: { mode: "monitor", timeout: 50 },
    });
    const response = await fetch(providerUrl, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    await CostKey.flush();
    expect(providerCalls).toBe(1);
  });

  it("exports only an allowlisted carrier and re-imports it explicitly", async () => {
    let carrier!: ReturnType<typeof CostKey.exportContext>;
    await CostKey.withContext(
      {
        traceId: "trace-carrier",
        traceName: "worker",
        executionId: "execution-1",
        feature: "search",
        privateLabel: "must-stay-local",
      },
      async () => {
        carrier = CostKey.exportContext();
        expect(carrier).toEqual({
          traceId: "trace-carrier",
          traceName: "worker",
          executionId: "execution-1",
          feature: "search",
        });
        const headers = CostKey.exportContextHeaders();
        expect(JSON.parse(headers["x-costkey-context"])).toEqual(carrier);

      },
    );
    await CostKey.withContext(JSON.stringify(carrier), async () => {
      expect(CostKey.getCurrentContext()).toEqual(carrier);
    });
  });

  it("deduplicates explicit revisions and preserves cumulative versus delta semantics", async () => {
    const additive: Array<Record<string, unknown>> = [];
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/usage-test",
      captureBody: false,
      maxBatchSize: 100,
      beforeSendEvent(event) {
        additive.push(event as unknown as Record<string, unknown>);
        return event;
      },
    });

    const usage = {
      id: "voice-revision-1",
      componentId: "voice-session-1",
      chargeId: "voice-charge-1",
      revision: 1,
      aggregation: "cumulative" as const,
      provider: "voice-provider",
      usage: { seconds: 2 },
      amount: { value: 0.1, currency: "USD" },
    };
    await CostKey.recordUsage(usage);
    await CostKey.recordUsage({ ...usage });
    await CostKey.recordUsage({
      ...usage,
      id: "voice-revision-2",
      revision: 2,
      usage: { seconds: 5 },
    });
    await CostKey.recordUsage({
      ...usage,
      id: "voice-stale-revision-0",
      revision: 0,
      usage: { seconds: 1 },
    });

    await CostKey.recordUsage({
      id: "meter-delta-2",
      componentId: "meter-component",
      chargeId: "meter-charge",
      revision: 2,
      aggregation: "delta",
      provider: "meter-provider",
      usage: { requests: 2 },
    });
    await CostKey.recordUsage({
      id: "meter-delta-1",
      componentId: "meter-component",
      chargeId: "meter-charge",
      revision: 1,
      aggregation: "delta",
      provider: "meter-provider",
      usage: { requests: 1 },
    });

    expect(() => CostKey.recordUsage({
      ...usage,
      id: "voice-conflict",
      revision: 2,
      usage: { seconds: 9 },
    })).toThrow(UsageConflictError);

    await CostKey.flush();
    const usageEvents = additive.filter((event) => event["eventType"] === "usage");
    expect(usageEvents).toHaveLength(4);
    expect(usageEvents.map((event) => event["revision"])).toEqual([1, 2, 2, 1]);
    expect(usageEvents[0]?.["amount"]).toEqual({ value: 0.1, currency: "USD" });
    expect(usageEvents[0]?.["nativeUsage"]).toEqual({ seconds: 2 });
    expect(usageEvents[2]).not.toHaveProperty("amount");
  });

  it("maps LiveKit modelUsage cumulative rows to native components without auto double capture", async () => {
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/livekit-test",
      captureBody: false,
      maxBatchSize: 100,
    });
    const update = {
      type: "session_usage_updated" as const,
      createdAt: 1_757_745_600_000,
      usage: {
        modelUsage: [
          {
            type: "llm_usage",
            provider: "openai",
            model: "gpt-4o",
            inputTokens: 10,
            outputTokens: 5,
          },
          {
            type: "stt_usage",
            provider: "deepgram",
            model: "nova-3",
            inputTokens: 20,
            outputTokens: 4,
            audioDurationMs: 1_250,
          },
          {
            type: "tts_usage",
            provider: "elevenlabs",
            model: "turbo",
            charactersCount: 30,
            audioDurationMs: 2_000,
          },
        ],
      },
    };
    const usageOptions = {
      sessionId: "voice-session-1",
      executionId: "voice-execution-1",
      revision: 7,
      expectedComponents: ["stt", "llm", "tts"],
    };
    const firstIds = await recordLiveKitUsage(update, usageOptions);
    const duplicateIds = await recordLiveKitUsage(update, usageOptions);
    expect(duplicateIds).toEqual(firstIds);
    await CostKey.withContext({ costkeyCapture: "manual" }, async () => {
      await fetch(providerUrl, { method: "POST", body: "{}" });
    });
    await CostKey.flush();

    const events = payloads.flatMap((payload) => payload.events);
    const usageEvents = events.filter((event) => event["eventType"] === "usage");
    expect(usageEvents).toHaveLength(3);
    const llm = usageEvents.find((event) => event["componentId"] === "livekit:voice-session-1:llm:openai:gpt-4o");
    const stt = usageEvents.find((event) => event["componentId"] === "livekit:voice-session-1:stt:deepgram:nova-3");
    const tts = usageEvents.find((event) => event["componentId"] === "livekit:voice-session-1:tts:elevenlabs:turbo");
    expect((stt?.["usage"] as Record<string, unknown>)["audioSeconds"]).toBe(1.25);
    expect((tts?.["usage"] as Record<string, unknown>)["audioSeconds"]).toBe(2);
    expect((tts?.["usage"] as Record<string, unknown>)["characters"]).toBe(30);
    expect(stt?.["unitKind"]).toBe("audio_seconds");
    expect(stt?.["unitValue"]).toBe(1.25);
    expect(tts?.["unitKind"]).toBe("characters");
    expect(tts?.["unitValue"]).toBe(30);
    expect(llm?.["unitKind"]).toBeUndefined();
    expect((llm?.["billingUnits"] as Record<string, unknown>)["input_tokens"]).toBe(10);
    expect((llm?.["billingUnits"] as Record<string, unknown>)["output_tokens"]).toBe(5);
    expect((stt?.["billingUnits"] as Record<string, unknown>)["audio_seconds"]).toBe(1.25);
    expect((tts?.["billingUnits"] as Record<string, unknown>)["characters"]).toBe(30);
    for (const event of usageEvents) {
      expect(((event["metadata"] as Record<string, unknown>)["livekit"] as Record<string, unknown>)["voiceCoverage"])
        .toMatchObject({ expectedComponents: ["llm", "stt", "tts"], missingComponents: [] });
    }
    expect(events.filter((event) => event["eventType"] === "call")).toHaveLength(0);
  });

  it("keeps LiveKit coverage complete and charge IDs stable when rows reorder or duplicate", async () => {
    const additive: Array<Record<string, unknown>> = [];
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/livekit-order-test",
      captureBody: false,
      maxBatchSize: 100,
      beforeSendEvent(event) {
        additive.push(event as unknown as Record<string, unknown>);
        return event;
      },
    });
    const rows = [
      { type: "tts_usage", provider: "voice", model: "synth", charactersCount: 5, audioDurationMs: 100 },
      { type: "llm_usage", provider: "voice", model: "brain", inputTokens: 2, outputTokens: 3 },
      { type: "stt_usage", provider: "voice", model: "listen", audioDurationMs: 200 },
    ];
    const first = await recordLiveKitUsage(
      { usage: { modelUsage: rows } },
      { sessionId: "order-session", revision: 1, expectedComponents: ["stt", "llm", "tts"] },
    );
    const reordered = await recordLiveKitUsage(
      { usage: { modelUsage: [...rows].reverse() } },
      { sessionId: "order-session", revision: 1, expectedComponents: ["stt", "llm", "tts"] },
    );
    expect(reordered).toEqual(first);

    const duplicateRows = [
      { type: "llm_usage", provider: "voice", model: "brain", inputTokens: 2, outputTokens: 3 },
      { type: "llm_usage", provider: "voice", model: "brain", inputTokens: 4, outputTokens: 1 },
    ];
    const duplicateIds = await recordLiveKitUsage(
      { usage: { modelUsage: duplicateRows } },
      { sessionId: "duplicate-session", revision: 2, expectedComponents: ["llm"] },
    );
    const duplicateReorderedIds = await recordLiveKitUsage(
      { usage: { modelUsage: [...duplicateRows].reverse() } },
      { sessionId: "duplicate-session", revision: 2, expectedComponents: ["llm"] },
    );
    expect(duplicateReorderedIds).toEqual(duplicateIds);
    await CostKey.flush();

    const usageEvents = additive.filter((event) => event["eventType"] === "usage");
    expect(usageEvents.filter((event) => String(event["componentId"]).startsWith("livekit:order-session:"))).toHaveLength(3);
    const merged = usageEvents.find((event) => String(event["componentId"]).startsWith("livekit:duplicate-session:llm:"));
    expect((merged?.["usage"] as Record<string, unknown>)["inputTokens"]).toBe(6);
    expect((merged?.["usage"] as Record<string, unknown>)["outputTokens"]).toBe(4);
    expect(((merged?.["metadata"] as Record<string, unknown>)["livekit"] as Record<string, unknown>)["voiceCoverage"])
      .toMatchObject({ expectedComponents: ["llm"], observedComponents: ["llm"], missingComponents: [] });
  });

  it("allows an explicit session component selection to avoid double-counting auto LLM calls", async () => {
    const additive: Array<Record<string, unknown>> = [];
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/livekit-selection-test",
      captureBody: false,
      maxBatchSize: 100,
      beforeSendEvent(event) {
        additive.push(event as unknown as Record<string, unknown>);
        return event;
      },
    });
    await fetch(providerUrl, { method: "POST", body: JSON.stringify({ model: "fake-model" }) });
    await recordLiveKitUsage(
      {
        usage: {
          modelUsage: [
            { type: "llm_usage", provider: "openai", model: "gpt-4o", inputTokens: 10, outputTokens: 5 },
            { type: "stt_usage", provider: "deepgram", model: "nova-3", audioDurationMs: 500 },
            { type: "tts_usage", provider: "elevenlabs", model: "turbo", charactersCount: 12 },
          ],
        },
      },
      {
        sessionId: "selection-session",
        revision: 1,
        expectedComponents: ["stt", "llm", "tts"],
        excludeComponents: ["llm"],
      },
    );
    await CostKey.flush();
    const events = payloads.flatMap((payload) => payload.events);
    expect(events.filter((event) => event["eventType"] === "call")).toHaveLength(1);
    const usageEvents = events.filter((event) => event["eventType"] === "usage");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents.every((event) => !String(event["componentId"]).includes(":llm:"))).toBe(true);
    expect(((usageEvents[0]?.["metadata"] as Record<string, unknown>)["livekit"] as Record<string, unknown>)["voiceCoverage"])
      .toMatchObject({ expectedComponents: ["stt", "tts"], excludedComponents: ["llm"], missingComponents: [] });
  });

  it("reports a failed trace without changing the application's thrown error", async () => {
    const additive: Array<Record<string, unknown>> = [];
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/failure-test",
      captureBody: false,
      beforeSendEvent(event) {
        additive.push(event as unknown as Record<string, unknown>);
        return event;
      },
    });

    const failure = new Error("application failure");
    expect(() => CostKey.startTrace({ name: "fails" }, () => { throw failure; })).toThrow(failure);
    await CostKey.flush();
    const lifecycle = additive.filter((event) => event["eventType"] === "lifecycle");
    expect(lifecycle.map((event) => event["lifecycle"])).toEqual(["started", "failed"]);
    expect(lifecycle[1]?.["errorType"]).toBe("Error");
  });

  it("advances lifecycle sequence when an execution is resumed with the same ID", async () => {
    const additive: Array<Record<string, unknown>> = [];
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/resume-test",
      captureBody: false,
      beforeSendEvent(event) {
        additive.push(event as unknown as Record<string, unknown>);
        return event;
      },
    });
    await CostKey.startExecution(
      { name: "resumable-job", kind: "batch", executionId: "execution-resume-1" },
      () => undefined,
    );
    await CostKey.startExecution(
      { name: "resumable-job", kind: "batch", executionId: "execution-resume-1" },
      () => undefined,
    );
    await CostKey.flush();

    const lifecycle = additive.filter(
      (event) => event["eventType"] === "lifecycle" && event["entityType"] === "execution",
    );
    expect(lifecycle.map((event) => event["sequence"])).toEqual([0, 1, 2, 3]);
    expect(lifecycle.map((event) => event["lifecycle"])).toEqual([
      "started",
      "completed",
      "started",
      "completed",
    ]);
  });

  it("marks AbortError boundaries cancelled without leaking the error message", async () => {
    const additive: Array<Record<string, unknown>> = [];
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/cancel-test",
      captureBody: false,
      beforeSendEvent(event) {
        additive.push(event as unknown as Record<string, unknown>);
        return event;
      },
    });
    const cancelled = Object.assign(new Error("private cancellation detail"), { name: "AbortError" });
    expect(() => CostKey.startTrace({ name: "cancelled" }, () => { throw cancelled; })).toThrow(cancelled);
    await CostKey.flush();
    const lifecycle = additive.filter((event) => event["eventType"] === "lifecycle");
    expect(lifecycle.map((event) => event["lifecycle"])).toEqual(["started", "cancelled"]);
    expect(lifecycle[1]).not.toHaveProperty("errorType");
    expect(JSON.stringify(lifecycle[1])).not.toContain("private cancellation detail");
  });

  it("does not retain usage revisions reported before initialization", async () => {
    await CostKey.shutdown();
    await CostKey.recordUsage({
      id: "before-init",
      componentId: "pre-init-component",
      revision: 1,
      aggregation: "delta",
      provider: "custom",
      usage: { requests: 1 },
    });
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/noop-test",
      captureBody: false,
    });
    await CostKey.flush();
    expect(payloads.flatMap((payload) => payload.events)).toHaveLength(0);
  });

  it("waits for delayed additive hooks before shutdown flushes transport", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    CostKey.init({
      dsn: "https://ck_test@costkey.dev/shutdown-test",
      captureBody: false,
      maxBatchSize: 100,
      beforeSendEvent: async (event) => {
        await gate;
        return event;
      },
    });

    const trace = CostKey.startTrace({ name: "delayed" }, () => "done");
    expect(trace).toBe("done");
    await Promise.resolve();
    const shutdown = CostKey.shutdown();
    release();
    await shutdown;

    const events = payloads.flatMap((payload) => payload.events);
    expect(events.filter((event) => event["eventType"] === "lifecycle")).toHaveLength(2);
  });

  it("bounds shutdown when an additive hook never resolves", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      CostKey.init({
        dsn: "https://ck_test@costkey.dev/never-hook-test",
        captureBody: false,
        debug: true,
        beforeSendEvent: () => new Promise(() => undefined),
      });
      CostKey.startTrace({ name: "never-hook" }, () => "done");
      const shutdown = CostKey.shutdown();
      await vi.advanceTimersByTimeAsync(5_000);
      await shutdown;
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Dropped 2 additive event(s) after bounded hook wait"),
      );
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });
});
