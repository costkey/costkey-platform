import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import {
  normalizeRole,
  redactRestrictedContent,
  roleCanReadContent,
} from "../permissions.js";
import {
  createAuthRouter,
  consumeOAuthState,
  consumeOAuthStatePayload,
  issueOAuthState,
  safeInternalReturnTo,
} from "../auth.js";
import { verifyWebhookSignature } from "../notifications.js";
import { verifyStripeWebhookSignature } from "../subscription.js";
import { createApp } from "../index.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("fixed roles preserve legacy member content access without granting unknown roles", () => {
  assert.equal(normalizeRole("owner"), "owner");
  assert.equal(normalizeRole("admin"), "admin");
  assert.equal(normalizeRole("developer"), "developer");
  assert.equal(normalizeRole("viewer"), "viewer");
  assert.equal(normalizeRole("member"), "developer");
  assert.equal(normalizeRole("custom-role"), "viewer");
  assert.equal(roleCanReadContent("member"), true);
  assert.equal(roleCanReadContent("viewer"), false);
});

test("viewer response serializer removes nested content but preserves safe cost grouping", () => {
  const result = redactRestrictedContent({
    total_cost: 4.2,
    function_name: "summarize",
    file_name: "/app/private.ts",
    metadata: {
      environment: "production",
      prompts: [{ role: "user", content: "private" }],
      raw: { secret: "private" },
    },
    context: {
      feature: "search",
      agent: { instructions: "private" },
      customer_email: "private",
    },
    request_body: { messages: [{ content: "private" }] },
    response_body: { choices: [{ content: "private" }] },
  }) as Record<string, unknown>;

  assert.equal(result.total_cost, 4.2);
  assert.equal(result.function_name, "summarize");
  assert.equal("file_name" in result, false);
  assert.deepEqual(result.metadata, { environment: "production" });
  assert.deepEqual(result.context, { feature: "search" });
  assert.equal("request_body" in result, false);
  assert.equal("response_body" in result, false);
});

test("viewer serializer preserves cost provenance while removing explicit source material", () => {
  const result = redactRestrictedContent({
    cost_usd: 1.25,
    cost_basis: "estimated",
    cost_source: "effective_price",
    pricing_id: "price_2026_09",
    pricing_date: "2026-09-01T00:00:00.000Z",
    effective_price: {
      source: "provider_documentation",
      price_id: "price_2026_09",
      rate: 0.00001,
    },
    source: "provider_documentation",
    source_code: "export function secret() { return prompt; }",
    file_name: "/srv/private.ts",
    stack_trace: "Error: private stack",
    arbitrary: { source: "source code in an untrusted nested blob" },
    metadata: {
      cost_source: "effective_price",
      source: "raw provider payload must not be copied from metadata",
      pricing_id: "price_2026_09",
      raw: { prompt: "private" },
    },
  }) as Record<string, unknown>;

  assert.equal(result.cost_basis, "estimated");
  assert.equal(result.cost_source, "effective_price");
  assert.equal(result.pricing_id, "price_2026_09");
  assert.deepEqual(result.effective_price, {
    source: "provider_documentation",
    price_id: "price_2026_09",
    rate: 0.00001,
  });
  assert.equal(result.source, "provider_documentation");
  assert.equal("source_code" in result, false);
  assert.equal("file_name" in result, false);
  assert.equal("stack_trace" in result, false);
  assert.deepEqual(result.arbitrary, {});
  assert.deepEqual(result.metadata, {});
});

test("OAuth return targets stay internal and signed state expires", () => {
  assert.equal(safeInternalReturnTo("/traces?call=abc&project=proj_1"), "/traces?call=abc&project=proj_1");
  assert.equal(safeInternalReturnTo("https://evil.example/steal"), null);
  assert.equal(safeInternalReturnTo("//evil.example/steal"), null);
  assert.equal(safeInternalReturnTo("/\\evil.example/steal"), null);
  assert.equal(safeInternalReturnTo("/login?returnTo=%2Fprivate"), null);

  const state = issueOAuthState("/traces?call=abc&project=proj_1");
  assert.equal(consumeOAuthState(state, undefined), false, "missing provider state must fail closed");
  assert.equal(consumeOAuthState(state, state), true);
  assert.equal(consumeOAuthState(state, `${state}tampered`), false, "tampered state must fail closed");
  const expiredState = issueOAuthState("/", Date.now() - 10 * 60 * 1000 - 1);
  assert.equal(consumeOAuthState(expiredState, expiredState), false, "expired state must fail closed");
  assert.equal(consumeOAuthStatePayload(state, state)?.returnTo, "/traces?call=abc&project=proj_1");
});

test("GitHub OAuth state is portable across instances and cookie replay fails closed", async () => {
  const oldClientId = process.env["GITHUB_CLIENT_ID"];
  process.env["GITHUB_CLIENT_ID"] = "client_test";
  const appA = express();
  appA.use(cookieParser());
  appA.use(createAuthRouter({} as import("pg").Pool));
  const appB = express();
  appB.use(cookieParser());
  appB.use(createAuthRouter({} as import("pg").Pool));
  const serverA = await new Promise<ReturnType<typeof appA.listen>>((resolve) => {
    const listening = appA.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const serverB = await new Promise<ReturnType<typeof appB.listen>>((resolve) => {
    const listening = appB.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const addressA = serverA.address();
    const addressB = serverB.address();
    assert.ok(addressA && typeof addressA !== "string");
    assert.ok(addressB && typeof addressB !== "string");
    const baseA = `http://127.0.0.1:${addressA.port}`;
    const baseB = `http://127.0.0.1:${addressB.port}`;
    const launch = await fetch(`${baseA}/auth/github?returnTo=${encodeURIComponent("/traces?call=abc&project=proj_1")}`, { redirect: "manual" });
    assert.equal(launch.status, 302);
    const location = new URL(launch.headers.get("location") ?? "");
    assert.ok((location.searchParams.get("state") ?? "").length > 100);
    assert.equal(location.searchParams.get("redirect_uri")?.endsWith("/auth/github/callback"), true);
    const setCookie = launch.headers.get("set-cookie") ?? "";
    const stateCookie = setCookie.match(/(?:^|,\s*)ck_oauth_state=([^;]+)/)?.[1];
    assert.ok(stateCookie);
    assert.equal(consumeOAuthStatePayload(stateCookie, location.searchParams.get("state"))?.returnTo, "/traces?call=abc&project=proj_1");

    const missing = await fetch(`${baseB}/auth/github/callback?code=unused`, { redirect: "manual" });
    assert.equal(missing.status, 302);
    assert.equal(missing.headers.get("location"), "/login?error=github_state");

    // The signed state does not depend on app A's process memory. Instance B
    // accepts its envelope before the missing code branch, without any GitHub
    // request; the response clears the browser cookie.
    const acceptedState = await fetch(`${baseB}/auth/github/callback?state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`, {
      redirect: "manual",
      headers: { cookie: `ck_oauth_state=${stateCookie}` },
    });
    assert.equal(acceptedState.headers.get("location"), "/login?error=github_denied");

    // A browser replay after cookie clearing has no binding and is rejected.
    const replay = await fetch(`${baseB}/auth/github/callback?code=unused&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`, {
      redirect: "manual",
    });
    assert.equal(replay.headers.get("location"), "/login?error=github_state");

    const launchTwo = await fetch(`${baseA}/auth/github`, { redirect: "manual" });
    const locationTwo = new URL(launchTwo.headers.get("location") ?? "");
    const setCookieTwo = launchTwo.headers.get("set-cookie") ?? "";
    const stateCookieTwo = setCookieTwo.match(/(?:^|,\s*)ck_oauth_state=([^;]+)/)?.[1];
    assert.ok(stateCookieTwo);
    const mismatch = await fetch(`${baseB}/auth/github/callback?code=unused&state=wrong`, {
      redirect: "manual",
      headers: { cookie: `ck_oauth_state=${stateCookieTwo}` },
    });
    assert.equal(mismatch.headers.get("location"), "/login?error=github_state");
    assert.ok((locationTwo.searchParams.get("state") ?? "").length > 100);
  } finally {
    serverA.closeIdleConnections?.();
    serverA.closeAllConnections?.();
    serverB.closeIdleConnections?.();
    serverB.closeAllConnections?.();
    await new Promise<void>((resolve) => serverA.close(() => resolve()));
    await new Promise<void>((resolve) => serverB.close(() => resolve()));
    if (oldClientId === undefined) delete process.env["GITHUB_CLIENT_ID"];
    else process.env["GITHUB_CLIENT_ID"] = oldClientId;
  }
});

test("signed generic webhook accepts the exact body and rejects tampering", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const body = JSON.stringify({ eventType: "test", cost: 1 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  assert.equal(verifyWebhookSignature(secret, timestamp, body, `sha256=${signature}`), true);
  assert.equal(verifyWebhookSignature(secret, timestamp, `${body}x`, `sha256=${signature}`), false);
});

test("Stripe webhook signature requires a current signed payload", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_test", type: "checkout.session.completed" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  assert.equal(verifyStripeWebhookSignature(body, `t=${timestamp},v1=${signature}`, secret), true);
  const tampered = `${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`;
  assert.equal(verifyStripeWebhookSignature(body, `t=${timestamp},v1=${tampered}`, secret), false);
});

test("dashboard static assets fail closed without auth or SPA fallback", async () => {
  const dashboardDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dashboard/dist");
  const assetsRoot = path.join(dashboardDist, "assets");
  const builtIndex = await readFile(path.join(dashboardDist, "index.html"), "utf8");
  const scriptHref = builtIndex.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  // The build uses relative asset URLs; the server anchors them when serving.
  assert.ok(scriptHref?.startsWith("./assets/") || scriptHref?.startsWith("/assets/"), "dashboard HTML must reference an assets entrypoint");
  const script = path.basename(new URL(scriptHref, "http://localhost").pathname);
  assert.ok(script.endsWith(".js") && !script.includes("/"), "dashboard entrypoint must be a local hashed JS asset");
  assert.ok(await readFile(path.join(assetsRoot, script), "utf8"), "dashboard HTML entrypoint must exist on disk");
  const app = createApp({ includeDashboard: true, startSchedulers: false });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const current = await fetch(`${base}/assets/${script}`);
    assert.equal(current.status, 200);
    assert.match(current.headers.get("cache-control") ?? "", /immutable/);
    await current.arrayBuffer();
    const stale = await fetch(`${base}/assets/stale-chunk-that-does-not-exist.js`);
    assert.equal(stale.status, 404);
    assert.match(stale.headers.get("content-type") ?? "", /javascript/);
    assert.doesNotMatch(await stale.text(), /<!doctype html/i);
    const index = await fetch(`${base}/`).then(async (response) => ({ response, body: await response.text() }));
    assert.equal(index.response.status, 200);
    assert.match(index.response.headers.get("cache-control") ?? "", /no-store/);
    assert.match(index.body, new RegExp(`assets/${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    app.stopSchedulers();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("health stays unhealthy while startup is pending or failed", async () => {
  const app = createApp({
    pool: {} as import("pg").Pool,
    includeDashboard: false,
    startSchedulers: false,
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const pending = await fetch(`${base}/health`);
    assert.equal(pending.status, 503);
    assert.deepEqual(await pending.json(), { status: "starting", version: process.env["COSTKEY_VERSION"] || "dev", commit: null });
    await assert.rejects(app.initialize());
    const failed = await fetch(`${base}/ready`);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { status: "error", version: process.env["COSTKEY_VERSION"] || "dev", commit: null });
  } finally {
    app.stopSchedulers();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("signed-out invitees can read their invitation through the full app", async () => {
  // Several routers apply requireAuth to every request they see; the public
  // invite preview must be mounted ahead of them.
  const pool = { query: async () => ({ rows: [] }) } as unknown as import("pg").Pool;
  const app = createApp({ pool, includeDashboard: false, startSchedulers: false });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/team/invite-preview/unknown-token`);
    assert.notEqual(response.status, 401);
    assert.equal(response.status, 404);
  } finally {
    app.stopSchedulers();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
