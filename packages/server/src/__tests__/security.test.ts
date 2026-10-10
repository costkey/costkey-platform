import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createApiRouter, escapeHtml } from "../api.js";
import { createServer } from "node:http";
import { cliCallbackUrl, parseCliCallbackPort, verifiedGithubEmail } from "../auth.js";
import { validContextKey } from "../accounting-api.js";
import { trustedEventTimestamp } from "../ingest.js";
import { csvCell } from "../platform.js";
import { redactSourceContent } from "../permissions.js";
import { stripIngestEventPrivacy } from "../privacy.js";
import { scrubDefinition, validateDefinition } from "../saved-views.js";

test("CLI callback ports and URLs stay strict loopback values", () => {
  assert.equal(parseCliCallbackPort("8080"), 8080);
  assert.equal(parseCliCallbackPort("0"), null);
  assert.equal(parseCliCallbackPort("65536"), null);
  assert.equal(parseCliCallbackPort("80@evil.example"), null);
  assert.equal(parseCliCallbackPort("8080.0"), null);
  assert.equal(cliCallbackUrl("8080")?.href, "http://localhost:8080/callback");
  assert.equal(cliCallbackUrl("80@evil.example"), null);
});

test("ingest does not let stale or future client clocks choose accounting dates", () => {
  const now = new Date("2026-09-13T12:00:00.000Z");
  assert.equal(trustedEventTimestamp("2026-09-13T11:00:00.000Z", now), "2026-09-13T11:00:00.000Z");
  assert.equal(trustedEventTimestamp("2026-09-01T00:00:00.000Z", now), now.toISOString());
  assert.equal(trustedEventTimestamp("2026-09-13T12:06:00.000Z", now), now.toISOString());
});

test("GitHub identity requires a verified email", () => {
  assert.equal(verifiedGithubEmail("attacker@example.test", [{ email: "attacker@example.test", primary: true, verified: false }]), null);
  assert.equal(verifiedGithubEmail("public@example.test", [{ email: "verified@example.test", primary: true, verified: true }]), "verified@example.test");
  assert.equal(verifiedGithubEmail("verified@example.test", [{ email: "verified@example.test", primary: false, verified: true }]), "verified@example.test");
});

test("context filters and saved definitions use explicit allowlists", () => {
  assert.equal(validContextKey("environment"), "environment");
  assert.equal(validContextKey("prompt"), null);
  assert.equal(validContextKey(["environment"]), null);
  assert.deepEqual(validateDefinition({ route: "traces", filters: { provider: ["openai"], prompt: "secret" }, prompt: "secret" }), {
    route: "traces", filters: { provider: ["openai"] },
  });
  assert.deepEqual(scrubDefinition({ contextKey: "prompt" }), {});
});

test("source-disabled and CSV boundaries remove source fields and formulas", () => {
  const event: Record<string, unknown> = {
    requestBody: { prompt: "secret" },
    metadata: { prompt: "secret" },
    callSite: { raw: "private" },
    callSiteFrames: [{ fileName: "/private/app.ts", lineNumber: 10 }],
    bl_file: "/private/app.ts",
    bl_function: "handler",
  };
  stripIngestEventPrivacy(event, { allowBody: false, allowSource: false });
  assert.equal("requestBody" in event, false);
  assert.equal("metadata" in event, false);
  assert.equal("callSite" in event, false);
  assert.equal("bl_file" in event, false);

  assert.deepEqual(redactSourceContent({ safe: "ok", nested: { file_name: "/private/app.ts", file: "/private/app.ts", function: "handler", value: 1 } }), {
    safe: "ok", nested: { value: 1 },
  });
  assert.equal(csvCell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
  assert.equal(csvCell("+cmd"), "'+cmd");
  assert.equal(csvCell(" =1+1"), "' =1+1");
  assert.equal(csvCell("normal"), "normal");
  assert.equal(escapeHtml("<img src=x onerror='x'>"), "&lt;img src=x onerror=&#39;x&#39;&gt;");
});

test("feedback HTTP route requires a session and rejects oversized messages", async () => {
  const pool = { async query() { return { rows: [] }; } };
  const unauthenticated = express();
  unauthenticated.use(express.json());
  unauthenticated.use(createApiRouter(pool as never));
  const firstServer = createServer(unauthenticated);
  await new Promise<void>((resolve) => firstServer.listen(0, "127.0.0.1", resolve));
  const firstAddress = firstServer.address();
  assert.ok(firstAddress && typeof firstAddress !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${firstAddress.port}/api/v1/feedback`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(response.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => firstServer.close((error) => error ? reject(error) : resolve()));
  }

  const authenticated = express();
  authenticated.use(express.json());
  authenticated.use((req, _res, next) => {
    (req as express.Request & { user?: unknown }).user = { id: "u1", orgId: "o1", role: "owner" };
    next();
  });
  authenticated.use(createApiRouter(pool as never));
  const secondServer = createServer(authenticated);
  await new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
  const secondAddress = secondServer.address();
  assert.ok(secondAddress && typeof secondAddress !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${secondAddress.port}/api/v1/feedback`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "x".repeat(4_001) }),
    });
    assert.equal(response.status, 413);
  } finally {
    await new Promise<void>((resolve, reject) => secondServer.close((error) => error ? reject(error) : resolve()));
  }
});
