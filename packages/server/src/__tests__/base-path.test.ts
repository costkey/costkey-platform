import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { createApp, renderDashboardIndex } from "../index.js";
import { initDatabase, shutdownDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { slackMessage } from "../notifications.js";

const dashboardIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dashboard/dist/index.html");
const dashboardBuilt = fs.existsSync(dashboardIndex);
const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

type Env = Record<string, string | undefined>;

function setEnv(values: Env): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  return () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  };
}

async function serve(app: ReturnType<typeof createApp>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      app.stopSchedulers();
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function cookie(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
}

const fakePool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
const cliState = "cli_state_0123456789abcdef";

test("index.html is anchored at the base path and tells the console where it lives", () => {
  const built = [
    "<!doctype html><html><head>",
    '<link rel="icon" href="./favicon.svg" />',
    '<script type="module" crossorigin src="./assets/index-abc.js"></script>',
    '<link rel="modulepreload" crossorigin href="./assets/chunk-def.js">',
    '<link rel="stylesheet" crossorigin href="./assets/index-ghi.css">',
    "</head><body></body></html>",
  ].join("\n");
  const prefixed = renderDashboardIndex(built, "/costkey");
  assert.match(prefixed, /<head>\s*<script>window\.__COSTKEY_BASE__="\/costkey";<\/script>/);
  assert.match(prefixed, /src="\/costkey\/assets\/index-abc\.js"/);
  assert.match(prefixed, /href="\/costkey\/assets\/chunk-def\.js"/);
  assert.match(prefixed, /href="\/costkey\/assets\/index-ghi\.css"/);
  assert.match(prefixed, /href="\/costkey\/favicon\.svg"/);
  assert.doesNotMatch(prefixed, /"\.\//);
  const root = renderDashboardIndex(built, "");
  assert.match(root, /window\.__COSTKEY_BASE__="";/);
  assert.match(root, /src="\/assets\/index-abc\.js"/);
  assert.match(root, /href="\/favicon\.svg"/);
  assert.match(renderDashboardIndex(built, "/a</script>"), /__COSTKEY_BASE__="\/a\\u003c\/script>"/, "the base path cannot close the script");
});

test("Slack and email links point under the base path", () => {
  const restore = setEnv({ PUBLIC_URL: "https://portal.example.com/costkey", COSTKEY_BASE_PATH: undefined });
  try {
    const button = (payload: Record<string, unknown>) => {
      const actions = (slackMessage(payload).blocks as Array<Record<string, unknown>>).find((block) => block.type === "actions")!;
      return String((actions.elements as Array<Record<string, unknown>>)[0]!.url);
    };
    assert.equal(button({ eventType: "finding", title: "t" }), "https://portal.example.com/costkey/alerting");
    assert.equal(button({ eventType: "finding", title: "t", link: "/traces?project=p1" }), "https://portal.example.com/costkey/traces?project=p1");
    assert.equal(button({ eventType: "finding", title: "t", link: "https://portal.example.com/costkey/overview?project=p1" }), "https://portal.example.com/costkey/overview?project=p1");
  } finally {
    restore();
  }
});

test("under a base path every route answers beneath it", { skip: !dashboardBuilt }, async () => {
  const restore = setEnv({ PUBLIC_URL: "http://localhost:4300/costkey", COSTKEY_BASE_PATH: undefined, GITHUB_CLIENT_ID: "gh_client_test", COSTKEY_COOKIE_SECURE: undefined });
  const app = createApp({ pool: fakePool, includeDashboard: true, startSchedulers: false });
  const { url, close } = await serve(app);
  try {
    // The console shell and its assets.
    const index = await fetch(`${url}/costkey/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /window\.__COSTKEY_BASE__="\/costkey"/);
    const script = html.match(/<script type="module"[^>]+src="([^"]+)"/)?.[1];
    assert.ok(script?.startsWith("/costkey/assets/"), `entrypoint is under the base path: ${script}`);
    const asset = await fetch(`${url}${script}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    await asset.arrayBuffer();
    const bare = await fetch(`${url}/costkey`);
    assert.equal(bare.status, 200, "the base path without a trailing slash is the console too");
    assert.match(await bare.text(), /__COSTKEY_BASE__="\/costkey"/);
    const login = await fetch(`${url}/costkey/login`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /__COSTKEY_BASE__/);
    const logo = await fetch(`${url}/costkey/providers/openai.svg`);
    assert.equal(logo.status, 200);
    await logo.arrayBuffer();
    const stale = await fetch(`${url}/costkey/assets/stale-chunk.js`);
    assert.equal(stale.status, 404);
    await stale.text();

    // Health answers at the root for platforms and under the base path.
    for (const route of ["/health", "/costkey/health"]) {
      const health = await fetch(`${url}${route}`);
      assert.equal(health.status, 503, route);
      assert.equal((await health.json() as { status: string }).status, "starting");
    }

    // Nothing else answers outside the base path; the root points at the console.
    const root = await fetch(`${url}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/costkey/");
    const outside = await fetch(`${url}/api/v1/team/invite-preview/unknown-token`);
    assert.equal(outside.status, 404);
    await outside.text();

    // The API under the base path.
    const invite = await fetch(`${url}/costkey/api/v1/team/invite-preview/unknown-token`);
    assert.equal(invite.status, 404);
    assert.match(invite.headers.get("content-type") ?? "", /json/);
    await invite.json();

    // Redirects and cookies carry the prefix.
    const cli = await fetch(`${url}/costkey/auth/cli?port=4567&state=${cliState}`, { redirect: "manual" });
    assert.equal(cli.status, 302);
    assert.equal(cli.headers.get("location"), "/costkey/login?cli=1");
    assert.match(cookie(cli, "ck_cli_state") ?? "", /Path=\/costkey(;|$)/);
    const github = await fetch(`${url}/costkey/auth/github?returnTo=%2Ftraces`, { redirect: "manual" });
    assert.equal(github.status, 302);
    const authorize = new URL(github.headers.get("location") ?? "");
    assert.equal(authorize.searchParams.get("redirect_uri"), "http://localhost:4300/costkey/auth/github/callback");
    assert.match(cookie(github, "ck_oauth_state") ?? "", /Path=\/costkey(;|$)/);
    const callback = await fetch(`${url}/costkey/auth/github/callback`, { redirect: "manual" });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/costkey/login?error=github_state");
    assert.match(cookie(callback, "ck_oauth_state") ?? "", /Path=\/costkey(;|$)/, "clearing uses the same path");
    const logout = await fetch(`${url}/costkey/auth/logout`, { method: "POST" });
    assert.equal(logout.status, 200);
    assert.match(cookie(logout, "ck_token") ?? "", /Path=\/costkey(;|$)/);
  } finally {
    await close();
    restore();
  }
});

test("at the root nothing changes", { skip: !dashboardBuilt }, async () => {
  const restore = setEnv({ PUBLIC_URL: "http://localhost:4301", COSTKEY_BASE_PATH: undefined, GITHUB_CLIENT_ID: "gh_client_test", COSTKEY_COOKIE_SECURE: undefined });
  const app = createApp({ pool: fakePool, includeDashboard: true, startSchedulers: false });
  const { url, close } = await serve(app);
  try {
    const html = await fetch(`${url}/`).then((response) => response.text());
    assert.match(html, /window\.__COSTKEY_BASE__="";/);
    const script = html.match(/<script type="module"[^>]+src="([^"]+)"/)?.[1];
    assert.ok(script?.startsWith("/assets/"), `entrypoint is at the root: ${script}`);
    const asset = await fetch(`${url}${script}`);
    assert.equal(asset.status, 200);
    await asset.arrayBuffer();
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 503);
    await health.json();
    const invite = await fetch(`${url}/api/v1/team/invite-preview/unknown-token`);
    assert.equal(invite.status, 404);
    await invite.json();
    const cli = await fetch(`${url}/auth/cli?port=4567&state=${cliState}`, { redirect: "manual" });
    assert.equal(cli.headers.get("location"), "/login?cli=1");
    assert.match(cookie(cli, "ck_cli_state") ?? "", /Path=\/(;|$)/);
    const github = await fetch(`${url}/auth/github`, { redirect: "manual" });
    assert.equal(new URL(github.headers.get("location") ?? "").searchParams.get("redirect_uri"), "http://localhost:4301/auth/github/callback");
    const callback = await fetch(`${url}/auth/github/callback`, { redirect: "manual" });
    assert.equal(callback.headers.get("location"), "/login?error=github_state");
    const logout = await fetch(`${url}/auth/logout`, { method: "POST" });
    assert.match(cookie(logout, "ck_token") ?? "", /Path=\/(;|$)/);
  } finally {
    await close();
    restore();
  }
});

test("signup, the DSN, the API and SDK events all work under a base path", { skip: !connectionString }, async () => {
  const restore = setEnv({ PUBLIC_URL: "http://localhost:4300/costkey", COSTKEY_BASE_PATH: undefined, COSTKEY_COOKIE_SECURE: undefined });
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  let close: (() => Promise<void>) | null = null;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    const app = createApp({ pool, includeDashboard: dashboardBuilt, initialize: false, startSchedulers: false });
    await app.initialize();
    const served = await serve(app);
    close = served.close;
    const base = `${served.url}/costkey`;

    const signup = await fetch(`${base}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `base-path-${suffix}@example.com`, password: "base-path-password", name: "Base Path" }),
    });
    assert.equal(signup.status, 201);
    const created = await signup.json() as { dsn: string; project: { id: string; authKey: string } };
    assert.equal(created.dsn, `http://${created.project.authKey}@localhost:4300/costkey/${created.project.id}`);
    const session = cookie(signup, "ck_token");
    assert.match(session ?? "", /Path=\/costkey(;|$)/);
    const sessionCookie = session!.split(";")[0]!;

    const me = await fetch(`${base}/auth/me`, { headers: { cookie: sessionCookie } });
    assert.equal(me.status, 200);
    const projects = await fetch(`${base}/api/v1/projects`, { headers: { cookie: sessionCookie } });
    assert.equal(projects.status, 200);
    await projects.json();

    // The SDK posts to <DSN host>/costkey/api/v1/events.
    const events = await fetch(`${base}/api/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${created.project.authKey}` },
      body: JSON.stringify({
        sdkVersion: "costkey-test/0.6.1",
        events: [{
          id: `bp_${suffix}`, timestamp: new Date(Date.now() - 1_000).toISOString(), durationMs: 120,
          provider: "openai", model: "gpt-4o-mini", url: "https://api.openai.com/v1/chat/completions", method: "POST", statusCode: 200,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, streaming: false,
        }],
      }),
    });
    assert.equal(events.status, 202, await events.clone().text());
    assert.equal((await events.json() as { accepted: number }).accepted, 1);
    const stored = await pool.query("SELECT COUNT(*)::int AS count FROM events WHERE project_id = $1", [created.project.id]);
    assert.equal(stored.rows[0].count, 1);

    if (dashboardBuilt) {
      // A deep link is served the console once the fallback is mounted.
      const deep = await fetch(`${base}/traces/some-run?project=${created.project.id}`);
      assert.equal(deep.status, 200);
      assert.match(await deep.text(), /__COSTKEY_BASE__="\/costkey"/);
    }
  } finally {
    await close?.();
    await pool.end();
    await shutdownDatabase();
    restore();
  }
});
