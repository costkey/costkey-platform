import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import pg from "pg";
import { initDatabase, shutdownDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { ensurePolicySchema } from "../policy-storage.js";
import { createApp } from "../index.js";
import { createIapJwks, IAP_ISSUER, setIapJwksForTesting } from "../sso/iap.js";
import { clearOidcCaches } from "../sso/oidc.js";
import { es256Key, signJwt, startStubIssuer } from "./helpers/sso-fixtures.js";

/**
 * Single sign-on against the real app and a disposable database. Needs
 * DATABASE_URL (and ACCOUNTING_TEST_DATABASE_URL) pointing at a database the
 * test may wipe: it truncates workspaces and users between cases.
 */
const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];
const canRun = Boolean(connectionString) && process.env["DATABASE_URL"] === connectionString;

const AUDIENCE = "/projects/123456789/regions/asia-south1/backendServices/987654321";
const iapKey = es256Key();

const ENV_KEYS = [
  "COSTKEY_AUTH", "COSTKEY_IAP_AUDIENCE", "COSTKEY_SSO_DEFAULT_ROLE", "PUBLIC_URL", "COSTKEY_BASE_PATH",
  "COSTKEY_OIDC_ISSUER", "COSTKEY_OIDC_CLIENT_ID", "COSTKEY_OIDC_CLIENT_SECRET", "COSTKEY_OIDC_ALLOWED_DOMAINS",
  "COSTKEY_OIDC_NAME", "COSTKEY_OIDC_SCOPES", "GITHUB_CLIENT_ID",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let pool: pg.Pool;
let server: Server;
let baseUrl = "";

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env["PUBLIC_URL"] = baseUrl;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function assertion(email: string, overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: IAP_ISSUER, aud: AUDIENCE, iat: now, exp: now + 600, sub: `sub-${email}`, email, ...overrides }, iapKey);
}

interface Reply { status: number; body: any; cookies: Record<string, string>; location: string | null }

async function call(path: string, options: { method?: string; body?: unknown; iap?: string; cookies?: Record<string, string>; bearer?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.iap) headers["x-goog-iap-jwt-assertion"] = options.iap;
  if (options.bearer) headers["authorization"] = `Bearer ${options.bearer}`;
  if (options.cookies && Object.keys(options.cookies).length) {
    headers["cookie"] = Object.entries(options.cookies).map(([name, value]) => `${name}=${value}`).join("; ");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });
  const cookies: Record<string, string> = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const index = pair!.indexOf("=");
    cookies[pair!.slice(0, index)] = decodeURIComponent(pair!.slice(index + 1));
  }
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body, cookies, location: response.headers.get("location") };
}

async function wipe(): Promise<void> {
  await pool.query("TRUNCATE orgs, users, team_invites, sso_removed_members CASCADE");
}

before(async () => {
  if (!canRun) return;
  await initDatabase();
  pool = new pg.Pool({ connectionString, max: 6 });
  await ensurePlatformSchema(pool);
  await ensurePolicySchema(pool);
  await pool.query("CREATE TABLE IF NOT EXISTS sso_removed_members (email TEXT PRIMARY KEY, org_id TEXT, removed_by TEXT, removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  setIapJwksForTesting(createIapJwks("https://jwks.invalid/iap", async () => new Response(JSON.stringify({ keys: [iapKey.jwk] }))));
  const app = createApp({ pool, includeDashboard: false, initialize: false, startSchedulers: false });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!canRun) return;
  setIapJwksForTesting(null);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  await shutdownDatabase();
});

beforeEach(async () => {
  if (!canRun) return;
  await wipe();
  clearOidcCaches();
});

test("password mode is unchanged and reports itself", { skip: !canRun }, async () => {
  setEnv({ GITHUB_CLIENT_ID: "gh" });
  const config = await call("/auth/config");
  assert.deepEqual(config.body, { mode: "password", password: true, github: true, configured: true });
  const signup = await call("/auth/signup", { method: "POST", body: { email: "pat@example.com", password: "correct horse", name: "Pat" } });
  assert.equal(signup.status, 201);
  const login = await call("/auth/login", { method: "POST", body: { email: "pat@example.com", password: "correct horse" } });
  assert.equal(login.status, 200);
  // The IAP header means nothing in password mode.
  const me = await call("/auth/me", { iap: assertion("someone@example.com") });
  assert.equal(me.body.authenticated, false);
});

test("IAP: first user owns a new workspace, later users get the default role", { skip: !canRun }, async () => {
  setEnv({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE });

  const alice = await call("/auth/me", { iap: assertion("Alice@Example.com") });
  assert.equal(alice.status, 200);
  assert.equal(alice.body.user.email, "alice@example.com");
  assert.equal(alice.body.user.role, "owner");
  assert.equal(alice.body.projects.length, 1, "the first user gets a default project");
  assert.ok(alice.cookies["ck_token"], "a normal session cookie is issued");

  // The session cookie is reused without re-issuing while it matches IAP.
  const again = await call("/auth/me", { iap: assertion("alice@example.com"), cookies: { ck_token: alice.cookies["ck_token"]! } });
  assert.equal(again.body.user.id, alice.body.user.id);
  assert.equal(again.cookies["ck_token"], undefined);

  const bob = await call("/auth/me", { iap: assertion("bob@example.com") });
  assert.equal(bob.body.user.role, "developer");
  assert.equal(bob.body.user.orgId, alice.body.user.orgId, "later users join the existing workspace");
  assert.equal(bob.body.projects.length, 1, "default-role members are assigned the workspace projects");

  setEnv({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE, COSTKEY_SSO_DEFAULT_ROLE: "viewer" });
  const carol = await call("/auth/me", { iap: assertion("carol@example.com") });
  assert.equal(carol.body.user.role, "viewer");

  // An invalid role falls back to viewer, never upwards.
  setEnv({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE, COSTKEY_SSO_DEFAULT_ROLE: "owner" });
  const dan = await call("/auth/me", { iap: assertion("dan@example.com") });
  assert.equal(dan.body.user.role, "viewer");

  const owners = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'owner'");
  assert.equal(owners.rows[0].n, 1);
});

test("IAP: concurrent first sign-ins create exactly one workspace", { skip: !canRun }, async () => {
  setEnv({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE });
  const replies = await Promise.all(["a1@example.com", "a2@example.com", "a3@example.com", "a4@example.com"]
    .map((email) => call("/auth/me", { iap: assertion(email) })));
  assert.ok(replies.every((reply) => reply.body.user));
  const orgs = await pool.query("SELECT COUNT(*)::int AS n FROM orgs");
  assert.equal(orgs.rows[0].n, 1);
  assert.equal(replies.filter((reply) => reply.body.user.role === "owner").length, 1);
});

test("IAP: without a valid assertion a session cookie is not enough", { skip: !canRun }, async () => {
  setEnv({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE });
  const alice = await call("/auth/me", { iap: assertion("alice@example.com") });
  const cookie = { ck_token: alice.cookies["ck_token"]! };

  const missing = await call("/auth/me", { cookies: cookie });
  assert.equal(missing.body.authenticated, false);
  // A session token moved into the Authorization header does not get around IAP.
  assert.equal((await call("/auth/me", { bearer: cookie.ck_token })).body.authenticated, false);
  assert.equal((await call("/auth/config", { cookies: cookie })).body.iap.status, "missing_assertion");

  const wrongAudience = assertion("alice@example.com", { aud: "/projects/1/global/backendServices/2" });
  assert.equal((await call("/auth/me", { iap: wrongAudience, cookies: cookie })).body.authenticated, false);
  assert.equal((await call("/auth/config", { iap: wrongAudience })).body.iap.status, "invalid_assertion");

  const expired = assertion("alice@example.com", { iat: Math.floor(Date.now() / 1000) - 1200, exp: Math.floor(Date.now() / 1000) - 600 });
  assert.equal((await call("/auth/me", { iap: expired })).body.authenticated, false);

  // The unsigned email header is never trusted.
  const unsigned = await fetch(`${baseUrl}/auth/me`, { headers: { "x-goog-authenticated-user-email": "accounts.google.com:alice@example.com" } });
  assert.equal((await unsigned.json() as { authenticated?: boolean }).authenticated, false);
  assert.equal((await call("/api/v1/team/invites")).status, 401);

  // A valid assertion for someone else replaces a stale cookie.
  const bob = await call("/auth/me", { iap: assertion("bob@example.com"), cookies: cookie });
  assert.equal(bob.body.user.email, "bob@example.com");
  assert.ok(bob.cookies["ck_token"]);

  const configured = await call("/auth/config", { iap: assertion("alice@example.com") });
  assert.equal(configured.body.mode, "iap");
  assert.equal(configured.body.password, false);
  assert.equal(configured.body.iap.status, "signed_in");
  assert.equal(configured.body.iap.logoutUrl, "/_gcp_iap/clear_login_cookie");
});

test("IAP: misconfiguration fails closed", { skip: !canRun }, async () => {
  setEnv({ COSTKEY_AUTH: "iap" });
  const reply = await call("/auth/me", { iap: assertion("alice@example.com") });
  assert.equal(reply.body.authenticated, false);
  const config = await call("/auth/config", { iap: assertion("alice@example.com") });
  assert.equal(config.body.configured, false);
  assert.equal(config.body.iap.status, "not_configured");
});

test("SSO modes reject password, signup and GitHub routes on the server", { skip: !canRun }, async () => {
  for (const mode of [{ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE }, { COSTKEY_AUTH: "oidc", COSTKEY_OIDC_ISSUER: "https://idp.example.com", COSTKEY_OIDC_CLIENT_ID: "c", COSTKEY_OIDC_CLIENT_SECRET: "s", COSTKEY_OIDC_ALLOWED_DOMAINS: "example.com" }]) {
    setEnv({ GITHUB_CLIENT_ID: "gh", ...mode });
    const login = await call("/auth/login", { method: "POST", body: { email: "pat@example.com", password: "correct horse" } });
    assert.equal(login.status, 403, mode.COSTKEY_AUTH);
    assert.equal(login.body.code, "password_auth_disabled");
    const signup = await call("/auth/signup", { method: "POST", body: { email: "new@example.com", password: "correct horse", name: "New", inviteToken: "x" } });
    assert.equal(signup.status, 403);
    assert.equal((await call("/auth/github")).status, 403);
    assert.equal((await call("/auth/github/callback?code=x&state=y")).status, 403);
    const config = await call("/auth/config");
    assert.equal(config.body.password, false);
    assert.equal(config.body.github, false);
  }
  const users = await pool.query("SELECT COUNT(*)::int AS n FROM users");
  assert.equal(users.rows[0].n, 0);
});

test("IAP: existing password users are matched by email and keep their data", { skip: !canRun }, async () => {
  setEnv({});
  const signup = await call("/auth/signup", { method: "POST", body: { email: "Pat@Example.com", password: "correct horse", name: "Pat", orgName: "Pat Co" } });
  assert.equal(signup.status, 201);
  setEnv({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE });
  const me = await call("/auth/me", { iap: assertion("pat@example.com") });
  assert.equal(me.body.user.id, signup.body.user.id);
  assert.equal(me.body.user.role, "owner");
  assert.equal(me.body.org.name, "Pat Co");
  assert.equal(me.body.projects[0].id, signup.body.project.id);
});

test("SDK endpoints work with the DSN and no IAP header", { skip: !canRun }, async () => {
  setEnv({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE });
  const alice = await call("/auth/me", { iap: assertion("alice@example.com") });
  const project = alice.body.projects[0];
  assert.ok(project.authKey);
  const events = await call("/api/v1/events", {
    method: "POST",
    bearer: project.authKey,
    body: { sdkVersion: "0.7.0", events: [{ id: `evt_${Date.now()}`, timestamp: new Date().toISOString(), durationMs: 10, provider: "openai", model: "gpt-4o", statusCode: 200, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }] },
  });
  assert.equal(events.status, 202, JSON.stringify(events.body));
  assert.equal((await call(`/api/v1/projects/${project.id}/config`, { bearer: project.authKey })).status, 200);
  assert.equal((await call("/api/v1/sdk/policy/policies", { bearer: project.authKey })).status, 200);
  const callgraph = await call(`/api/v1/projects/${project.id}/callgraph`, { method: "POST", bearer: project.authKey, body: { nodes: [], edges: [] } });
  assert.notEqual(callgraph.status, 401);
  assert.notEqual(callgraph.status, 403);
  // A wrong key is still refused.
  assert.equal((await call(`/api/v1/projects/${project.id}/config`, { bearer: "ck_wrong" })).status, 401);
});

test("SSO invites apply on first sign-in; removal sticks until re-invited", { skip: !canRun }, async () => {
  setEnv({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE, COSTKEY_SSO_DEFAULT_ROLE: "viewer" });
  const owner = assertion("alice@example.com");
  await call("/auth/me", { iap: owner });
  const invite = await call("/api/v1/team/invite", { method: "POST", iap: owner, body: { email: "Erin@Example.com", role: "admin" } });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  assert.equal(invite.body.inviteUrl, `${baseUrl}/login`);
  assert.ok(new Date(invite.body.expiresAt).getTime() > Date.now() + 30 * 86_400_000, "SSO invites are long lived");
  const erin = await call("/auth/me", { iap: assertion("erin@example.com") });
  assert.equal(erin.body.user.role, "admin");
  const accepted = await pool.query("SELECT status FROM team_invites WHERE id = $1", [invite.body.id]);
  assert.equal(accepted.rows[0].status, "accepted");

  const bob = await call("/auth/me", { iap: assertion("bob@example.com") });
  assert.equal(bob.body.user.role, "viewer");
  const promote = await call(`/api/v1/team/members/${bob.body.user.id}`, { method: "PATCH", iap: owner, body: { role: "developer" } });
  assert.equal(promote.status, 200);
  assert.equal((await call("/auth/me", { iap: assertion("bob@example.com") })).body.user.role, "developer");

  const remove = await call(`/api/v1/team/members/${bob.body.user.id}`, { method: "DELETE", iap: owner });
  assert.equal(remove.status, 200);
  const blocked = await call("/auth/me", { iap: assertion("bob@example.com") });
  assert.equal(blocked.body.authenticated, false);
  assert.equal((await call("/auth/config", { iap: assertion("bob@example.com") })).body.iap.status, "access_removed");

  const reinvite = await call("/api/v1/team/invite", { method: "POST", iap: owner, body: { email: "bob@example.com", role: "viewer" } });
  assert.equal(reinvite.status, 201);
  const back = await call("/auth/me", { iap: assertion("bob@example.com") });
  assert.equal(back.body.user.role, "viewer");
});

test("IAP: CLI browser login completes through IAP, and logout clears the IAP cookie", { skip: !canRun }, async () => {
  setEnv({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE });
  const iap = assertion("alice@example.com");
  const start = await call("/auth/cli?port=48123&state=abcdefghijklmnopqrstuvwxyz", { iap });
  assert.equal(start.status, 302);
  assert.equal(start.location, "/login?cli=1");
  assert.ok(start.cookies["ck_token"], "the IAP identity signs in on the first request");
  const token = await call("/auth/cli-token", {
    method: "POST",
    iap,
    cookies: { ck_token: start.cookies["ck_token"]!, ck_cli_port: start.cookies["ck_cli_port"]!, ck_cli_state: start.cookies["ck_cli_state"]! },
  });
  assert.equal(token.status, 200, JSON.stringify(token.body));
  assert.equal(token.body.port, "48123");
  assert.ok(token.body.token);
  // The CLI's bearer token works without IAP (for routes the load balancer lets through).
  const me = await call("/auth/me", { bearer: token.body.token });
  assert.equal(me.body.user.email, "alice@example.com");

  const logout = await call("/auth/logout", { method: "POST", iap, cookies: { ck_token: start.cookies["ck_token"]! } });
  assert.equal(logout.status, 200);
  assert.equal(logout.body.redirectTo, "/_gcp_iap/clear_login_cookie");
  assert.equal(logout.cookies["ck_token"], "", "the CostKey session is cleared, not re-issued");
});

test("OIDC: code flow with PKCE signs in and provisions; domain allowlist enforced", { skip: !canRun }, async () => {
  const stub = await startStubIssuer({ clientId: "costkey", clientSecret: "secret" });
  try {
    setEnv({
      COSTKEY_AUTH: "oidc", COSTKEY_OIDC_ISSUER: stub.issuer, COSTKEY_OIDC_CLIENT_ID: "costkey",
      COSTKEY_OIDC_CLIENT_SECRET: "secret", COSTKEY_OIDC_ALLOWED_DOMAINS: "example.com", COSTKEY_OIDC_NAME: "Okta",
    });
    const config = await call("/auth/config");
    assert.deepEqual(config.body, { mode: "oidc", password: false, github: false, configured: true, oidc: { name: "Okta", startPath: "/auth/oidc/start" } });

    const signIn = async (claims: Record<string, unknown>, returnTo = "/costs", tamper?: (state: string) => string): Promise<Reply> => {
      const start = await call(`/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`);
      assert.equal(start.status, 302);
      const authorize = new URL(start.location!);
      assert.equal(authorize.searchParams.get("redirect_uri"), `${baseUrl}/auth/oidc/callback`);
      const code = stub.approve(start.location!, claims);
      const state = authorize.searchParams.get("state")!;
      return call(`/auth/oidc/callback?code=${code}&state=${encodeURIComponent(tamper ? tamper(state) : state)}`, {
        cookies: { ck_oidc_flow: start.cookies["ck_oidc_flow"]! },
      });
    };

    const first = await signIn({ email: "alice@example.com", email_verified: true, name: "Alice" }, "/");
    assert.equal(first.status, 302);
    assert.equal(first.location, "/onboarding", "the workspace creator goes to setup");
    const me = await call("/auth/me", { cookies: { ck_token: first.cookies["ck_token"]! } });
    assert.equal(me.body.user.role, "owner");
    assert.equal(me.body.user.name, "Alice");

    const second = await signIn({ email: "bob@example.com", email_verified: true });
    assert.equal(second.location, "/costs");
    assert.equal((await call("/auth/me", { cookies: { ck_token: second.cookies["ck_token"]! } })).body.user.role, "developer");

    const outsider = await signIn({ email: "mallory@evil.io", email_verified: true });
    assert.equal(outsider.location, "/login?error=oidc_domain");
    assert.equal(outsider.cookies["ck_token"], undefined);

    const unverified = await signIn({ email: "eve@example.com", email_verified: false });
    assert.equal(unverified.location, "/login?error=oidc_email_unverified");

    const forged = await signIn({ email: "carol@example.com" }, "/", (state) => `${state.slice(0, -2)}xx`);
    assert.equal(forged.location, "/login?error=oidc_state");

    const noCookie = await call(`/auth/oidc/callback?code=x&state=y`);
    assert.equal(noCookie.location, "/login?error=oidc_state");

    const users = await pool.query("SELECT email FROM users ORDER BY email");
    assert.deepEqual(users.rows.map((row) => row.email), ["alice@example.com", "bob@example.com"]);
  } finally {
    await stub.close();
  }
});
