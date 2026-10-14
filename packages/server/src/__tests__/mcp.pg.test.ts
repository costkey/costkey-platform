import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { initDatabase, shutdownDatabase } from "../db.js";
import { createApp } from "../index.js";
import { hashApiToken } from "../api-tokens.js";

/**
 * Personal access tokens and the MCP endpoint through the real app: startup
 * DDL, authMiddleware, the console's REST routes and their Viewer redaction,
 * and /mcp driven by the MCP SDK client.
 */
const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];
const canRun = Boolean(connectionString);
const JWT_SECRET = "costkey-test-only-secret";

const suffix = randomBytes(5).toString("hex");
const orgId = `org_mcp_${suffix}`;
const projectA = `proj_mcpa_${suffix}`;
const projectB = `proj_mcpb_${suffix}`;
const owner = `u_mcp_owner_${suffix}`;
const developer = `u_mcp_dev_${suffix}`;
const viewer = `u_mcp_view_${suffix}`;

let pool: pg.Pool;
let server: Server;
let baseUrl = "";

function session(userId: string, role: string): string {
  return jwt.sign({ userId, orgId, role }, JWT_SECRET, { expiresIn: "1h" });
}

async function call(path: string, options: { method?: string; cookie?: string; bearer?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers["Cookie"] = `ck_token=${options.cookie}`;
  if (options.bearer) headers["Authorization"] = `Bearer ${options.bearer}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body };
}

async function mintToken(userId: string, role: string, input: Record<string, unknown> = {}): Promise<{ id: string; secret: string }> {
  const created = await call("/api/v1/agent-tokens", { method: "POST", cookie: session(userId, role), body: { name: `test ${role}`, ...input } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { id: created.body.token.id, secret: created.body.secret };
}

async function mcp(token: string): Promise<Client> {
  const client = new Client({ name: "costkey-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return { text: content.map((item) => item.text ?? "").join("\n"), isError: result.isError === true };
}

const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const SOURCE_LINE = "  const reply = await openai.chat.completions.create(request);";
const ANSWER = "A short summary of the article.";
const SYSTEM = "You write one-line summaries.";

before(async () => {
  if (!canRun) return;
  await initDatabase();
  pool = new pg.Pool({ connectionString, max: 8 });
  const runtime = createApp({ pool, includeDashboard: false, initialize: false, startSchedulers: false });
  await runtime.initialize();
  server = createServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;

  await pool.query("INSERT INTO orgs(id, name, slug) VALUES ($1, 'MCP', $2)", [orgId, `mcp-${suffix}`]);
  for (const [id, role] of [[owner, "owner"], [developer, "developer"], [viewer, "viewer"]]) {
    await pool.query("INSERT INTO users(id, email, password_hash, name, org_id, role) VALUES ($1, $2, 'x', $1, $3, $4)", [id, `${id}@mcp.test`, orgId, role]);
  }
  for (const [id, name] of [[projectA, "Atlas"], [projectB, "Billing"]]) {
    await pool.query("INSERT INTO projects(id, name, org_id, auth_key) VALUES ($1, $2, $3, $4)", [id, name, orgId, `ck_${id}`]);
    await pool.query(
      `INSERT INTO project_settings(project_id, capture_mode, body_capture_enabled, redaction_enabled, body_retention_days, metadata_retention_days, aggregate_retention_days, source_access_enabled)
       VALUES ($1, 'text', TRUE, TRUE, 7, 30, 395, TRUE) ON CONFLICT (project_id) DO NOTHING`,
      [id],
    );
  }
  // The developer and the viewer are assigned to Atlas only.
  for (const userId of [developer, viewer]) {
    await pool.query("INSERT INTO project_memberships(project_id, user_id) VALUES ($1, $2)", [projectA, userId]);
  }

  const frames = [
    { functionName: "summarize", fileName: "/app/src/agents/summarize.ts", lineNumber: 42, columnNumber: 5, preContext: ["export async function summarize(text: string) {", "  const request = build(text);"], contextLine: SOURCE_LINE, postContext: ["  return reply;"] },
    { functionName: "create", fileName: "/app/node_modules/openai/resources/chat.js", lineNumber: 10, columnNumber: 1 },
  ];
  const messages = [{ role: "system", content: SYSTEM }, ...Array.from({ length: 9 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn ${index}` }))];
  const insert = async (row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    await pool.query(
      `INSERT INTO events (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
      columns.map((column) => {
        const value = row[column];
        return value && typeof value === "object" ? JSON.stringify(value) : value;
      }),
    );
  };
  const base = { project_id: projectA, provider: "openai", model: "gpt-4o-mini", input_tokens: 1200, output_tokens: 40, duration_ms: 820 };
  // A successful run with one call, prompt and response captured.
  await insert({
    ...base, id: `call_ok_${suffix}`, timestamp: at(120), cost_usd: 0.0012, cost_basis: "estimated", status_code: 200,
    trace_id: `run_ok_${suffix}`, trace_name: "summarize-article", context: { feature: "summarize", environment: "production" },
    bl_file: "/app/src/agents/summarize.ts", bl_function: "summarize", bl_line: 42, call_site_frames: frames,
    request_body: { model: "gpt-4o-mini", messages }, response_body: { choices: [{ message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }] },
    content_status: "captured", release: "1.4.2",
  });
  // A run whose tool's call was rate limited; the agent span errored.
  await insert({
    ...base, id: `call_429_${suffix}`, timestamp: at(60), cost_usd: null, status_code: 429, lifecycle_state: "failed", lifecycle_error_type: "http_429",
    trace_id: `run_bad_${suffix}`, trace_name: "research", span_id: `span_tool_${suffix}`, context: { feature: "research", environment: "production" },
    bl_file: "/app/src/agents/summarize.ts", bl_function: "summarize", bl_line: 42, call_site_frames: frames,
    request_body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "search" }] },
    response_body: { error: { type: "rate_limit_error", message: "Rate limit reached for gpt-4o-mini" } }, content_status: "captured",
  });
  for (const [id, kind, name, status, parent, started] of [
    [`span_agent_${suffix}`, "agent", "researcher", "error", null, 70],
    [`span_tool_${suffix}`, "tool", "web_search", "ok", `span_agent_${suffix}`, 65],
  ] as const) {
    await pool.query(
      `INSERT INTO spans (id, project_id, trace_id, parent_span_id, kind, name, status, error_type, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, projectA, `run_bad_${suffix}`, parent, kind, name, status, status === "error" ? "ToolError" : null, at(started), at(50)],
    );
  }
  // Another file, and a file whose name only ends with the same letters.
  await insert({ ...base, id: `call_expired_${suffix}`, timestamp: at(180), cost_usd: 0.002, status_code: 200, bl_file: "/app/src/agents/classify.ts", bl_function: "classify", bl_line: 7, content_status: "expired" });
  await insert({ ...base, id: `call_lookalike_${suffix}`, timestamp: at(200), cost_usd: 0.003, status_code: 200, bl_file: "/app/src/agents/resummarize.ts", bl_function: "resummarize", bl_line: 3, content_status: "metadata_only" });
  // Billing: a project the developer is not assigned to.
  await insert({ ...base, project_id: projectB, id: `call_billing_${suffix}`, timestamp: at(30), cost_usd: 0.5, status_code: 200, bl_file: "/srv/billing.py", bl_function: "invoice", bl_line: 1 });
});

after(async () => {
  if (!canRun) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const table of ["events", "spans", "traces"]) await pool.query(`DELETE FROM ${table} WHERE project_id = ANY($1)`, [[projectA, projectB]]).catch(() => undefined);
  await pool.query("DELETE FROM api_tokens WHERE org_id = $1", [orgId]).catch(() => undefined);
  await pool.query("DELETE FROM project_memberships WHERE project_id = ANY($1)", [[projectA, projectB]]).catch(() => undefined);
  await pool.query("DELETE FROM projects WHERE org_id = $1", [orgId]).catch(() => undefined);
  await pool.query("DELETE FROM users WHERE org_id = $1", [orgId]).catch(() => undefined);
  await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
  await pool.end();
  await shutdownDatabase();
});

test("tokens are created and revoked from a console session only, and stored as a hash", { skip: !canRun }, async () => {
  const { id, secret } = await mintToken(developer, "developer");
  assert.match(secret, /^ck_pat_/);
  const stored = await pool.query("SELECT token_hash, scopes, user_id FROM api_tokens WHERE id = $1", [id]);
  assert.equal(stored.rows[0].token_hash, hashApiToken(secret));
  assert.deepEqual(stored.rows[0].scopes, ["read"]);
  const inDatabase = await pool.query("SELECT 1 FROM api_tokens WHERE token_hash = $1 OR name = $1 OR token_hint = $1", [secret]);
  assert.equal(inDatabase.rows.length, 0, "the token itself is never stored");

  const list = await call("/api/v1/agent-tokens", { cookie: session(developer, "developer") });
  assert.equal(list.status, 200);
  assert.ok(list.body.tokens.some((token: { id: string }) => token.id === id));
  assert.ok(!JSON.stringify(list.body).includes(secret));
  assert.match(list.body.mcpUrl, /\/mcp$/);

  // A token can't mint, list or revoke tokens; neither can a bearer session.
  assert.equal((await call("/api/v1/agent-tokens", { bearer: secret })).status, 403);
  assert.equal((await call("/api/v1/agent-tokens", { method: "POST", bearer: secret, body: { name: "x" } })).status, 403);
  assert.equal((await call(`/api/v1/agent-tokens/${id}`, { method: "DELETE", bearer: secret })).status, 403);
  assert.equal((await call("/api/v1/agent-tokens", { method: "POST", bearer: session(developer, "developer"), body: { name: "x" } })).status, 403);
  // Someone else's token can't be revoked.
  assert.equal((await call(`/api/v1/agent-tokens/${id}`, { method: "DELETE", cookie: session(viewer, "viewer") })).status, 404);

  assert.equal((await call(`/api/v1/projects/${projectA}/events`, { bearer: secret })).status, 200);
  assert.equal((await call(`/api/v1/agent-tokens/${id}`, { method: "DELETE", cookie: session(developer, "developer") })).status, 200);
  assert.equal((await call(`/api/v1/projects/${projectA}/events`, { bearer: secret })).status, 401, "a revoked token stops working");
});

test("a token only reads: every write and every other route is refused", { skip: !canRun }, async () => {
  const { secret } = await mintToken(owner, "owner");
  assert.equal((await call("/api/v1/projects", { bearer: secret })).status, 200);
  assert.equal((await call(`/api/v1/projects/${projectA}/traces`, { bearer: secret })).status, 200);
  for (const [method, path] of [
    ["POST", "/api/v1/projects"],
    ["PATCH", `/api/v1/projects/${projectA}`],
    ["DELETE", `/api/v1/projects/${projectA}`],
    ["POST", `/api/v1/projects/${projectA}/rotate-key`],
    ["POST", `/api/v1/projects/${projectA}/findings/refresh`],
    ["GET", "/auth/me"],
    ["GET", "/api/v1/workspace/settings"],
    ["GET", "/api/v1/team/invites"],
    ["POST", "/api/v1/events"],
  ] as const) {
    const response = await call(path, { method, bearer: secret, body: method === "GET" ? undefined : {} });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  // Read-only even for an owner: no ingest keys or DSNs.
  const projects = await call("/api/v1/projects", { bearer: secret });
  assert.equal(projects.body.projects.length, 2);
  assert.ok(!JSON.stringify(projects.body).includes(`ck_${projectA}`));
  assert.ok(projects.body.projects.every((project: Record<string, unknown>) => !("authKey" in project) && !("dsn" in project)));
  // A garbled or unknown token is refused, not treated as signed out.
  assert.equal((await call(`/api/v1/projects/${projectA}/events`, { bearer: "ck_pat_not-a-real-token-at-all-000000000000" })).status, 401);
});

test("an expired token stops working", { skip: !canRun }, async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const { id, secret } = await mintToken(developer, "developer", { expiresAt: future });
  assert.equal((await call(`/api/v1/projects/${projectA}/events`, { bearer: secret })).status, 200);
  await pool.query("UPDATE api_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [id]);
  assert.equal((await call(`/api/v1/projects/${projectA}/events`, { bearer: secret })).status, 401);
  const past = await call("/api/v1/agent-tokens", { method: "POST", cookie: session(developer, "developer"), body: { name: "x", expiresAt: "2001-01-01" } });
  assert.equal(past.status, 400);
});

test("a token limited to some projects can't read the others", { skip: !canRun }, async () => {
  const { secret } = await mintToken(owner, "owner", { projectIds: [projectA] });
  const projects = await call("/api/v1/projects", { bearer: secret });
  assert.deepEqual(projects.body.projects.map((project: { id: string }) => project.id), [projectA]);
  assert.equal((await call(`/api/v1/projects/${projectB}/events`, { bearer: secret })).status, 404);
  assert.equal((await call(`/api/v1/projects/${projectA}/events`, { bearer: secret })).status, 200);
  // A developer can't make a token for a project they aren't assigned to.
  const refused = await call("/api/v1/agent-tokens", { method: "POST", cookie: session(developer, "developer"), body: { name: "x", projectIds: [projectB] } });
  assert.equal(refused.status, 400);
  // Nor read it with an unrestricted token.
  const { secret: devSecret } = await mintToken(developer, "developer");
  assert.equal((await call(`/api/v1/projects/${projectB}/events`, { bearer: devSecret })).status, 404);
  const client = await mcp(secret);
  try {
    const result = await tool(client, "find_calls", { project: "Billing", since: "1h" });
    assert.equal(result.isError, true);
    assert.match(result.text, /No project "Billing"/);
  } finally { await client.close(); }
});

test("a token acts at its owner's current role, never above it", { skip: !canRun }, async () => {
  const { secret } = await mintToken(developer, "developer");
  const asDeveloper = await call(`/api/v1/projects/${projectA}/events/call_ok_${suffix}`, { bearer: secret });
  assert.equal(asDeveloper.body.event.request_body.messages[0].content, SYSTEM);
  await pool.query("UPDATE users SET role = 'viewer' WHERE id = $1", [developer]);
  try {
    const demoted = await call(`/api/v1/projects/${projectA}/events/call_ok_${suffix}`, { bearer: secret });
    assert.equal(demoted.status, 200);
    assert.equal(demoted.body.event.request_body, undefined, "a demotion applies to existing tokens at once");
  } finally {
    await pool.query("UPDATE users SET role = 'developer' WHERE id = $1", [developer]);
  }
  // A member who leaves takes their tokens with them.
  await pool.query("DELETE FROM project_memberships WHERE user_id = $1", [developer]);
  try {
    assert.equal((await call(`/api/v1/projects/${projectA}/events`, { bearer: secret })).status, 404);
  } finally {
    await pool.query("INSERT INTO project_memberships(project_id, user_id) VALUES ($1, $2)", [projectA, developer]);
  }
});

test("calls filter by source file: the exact path or its ending, at a path boundary", { skip: !canRun }, async () => {
  const { secret } = await mintToken(developer, "developer");
  const ids = async (query: string) => {
    const response = await call(`/api/v1/projects/${projectA}/events?${query}`, { bearer: secret });
    assert.equal(response.status, 200);
    return response.body.events.map((event: { id: string }) => event.id).sort();
  };
  const summarize = [`call_429_${suffix}`, `call_ok_${suffix}`];
  assert.deepEqual(await ids("file=src/agents/summarize.ts"), summarize);
  assert.deepEqual(await ids("file=./src/agents/summarize.ts"), summarize);
  assert.deepEqual(await ids("file=/app/src/agents/summarize.ts"), summarize);
  assert.deepEqual(await ids("file=summarize.ts"), summarize, "resummarize.ts is a different file");
  assert.deepEqual(await ids("file=agents/classify.ts"), [`call_expired_${suffix}`]);
  assert.deepEqual(await ids("file=marize.ts"), []);
  assert.deepEqual(await ids("functionName=classify"), [`call_expired_${suffix}`]);
  assert.deepEqual(await ids("outcome=failed"), [`call_429_${suffix}`]);
  const runs = await call(`/api/v1/projects/${projectA}/traces?outcome=failed`, { bearer: secret });
  assert.deepEqual(runs.body.traces.map((trace: { trace_id: string }) => trace.trace_id), [`run_bad_${suffix}`]);
  // Without source access a file filter is not applied, as for the console.
  const { secret: viewerSecret } = await mintToken(viewer, "viewer");
  const viewerEvents = await call(`/api/v1/projects/${projectA}/events?file=agents/classify.ts`, { bearer: viewerSecret });
  assert.equal(viewerEvents.body.events.length, 4);
});

test("MCP: tools list, read-only, and answer through the real endpoint", { skip: !canRun }, async () => {
  const { secret } = await mintToken(developer, "developer");
  const client = await mcp(secret);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((item) => item.name).sort(), ["cost_breakdown", "find_calls", "find_runs", "get_call", "get_run", "hot_call_sites", "list_projects", "recent_errors"]);
    assert.ok(tools.every((item) => item.annotations?.readOnlyHint === true && item.description && item.description.length > 40));

    const projects = await tool(client, "list_projects");
    assert.match(projects.text, /Atlas/);
    assert.doesNotMatch(projects.text, /Billing/, "only the projects this developer can read");

    // One readable project: project can be left out.
    const calls = await tool(client, "find_calls", { file: "src/agents/summarize.ts", since: "1h" });
    assert.equal(calls.isError, false, calls.text);
    assert.match(calls.text, /^2 calls in Atlas · last 1h · file src\/agents\/summarize.ts/);
    assert.match(calls.text, new RegExp(`1\\. call_429_${suffix} · .* · openai/gpt-4o-mini · FAILED: Rate limited \\(429\\)`));
    assert.match(calls.text, /\/app\/src\/agents\/summarize.ts:42 summarize\(\)/);
    assert.match(calls.text, new RegExp(`/traces/run_ok_${suffix}\\?project=${projectA}&call=call_ok_${suffix}`));
    assert.doesNotMatch(calls.text, /resummarize/);

    const failed = await tool(client, "find_calls", { status: "failed", since: "1h" });
    assert.match(failed.text, /^1 call in Atlas/);

    const detail = await tool(client, "get_call", { call_id: `call_ok_${suffix}` });
    assert.equal(detail.isError, false, detail.text);
    assert.match(detail.text, new RegExp(`# Call call_ok_${suffix} · HTTP 200`));
    assert.match(detail.text, /Usage: 1,200 in · 40 out/);
    assert.match(detail.text, /Cost: \$0\.0012/);
    assert.match(detail.text, /release 1\.4\.2/);
    assert.match(detail.text, new RegExp(`>\\s+42 \\|\\s+${SOURCE_LINE.trim().replace(/[.()]/g, "\\$&")}`));
    assert.doesNotMatch(detail.text, /node_modules\/openai/, "library frames only when asked");
    assert.match(detail.text, new RegExp(`\\[system\\] ${SYSTEM}`));
    assert.match(detail.text, /3 earlier messages omitted/);
    assert.match(detail.text, new RegExp(ANSWER));

    const everything = await tool(client, "get_call", { call_id: `call_ok_${suffix}`, include: ["messages", "frames"] });
    assert.match(everything.text, /node_modules\/openai/);
    assert.doesNotMatch(everything.text, /earlier messages omitted/);

    const rateLimited = await tool(client, "get_call", { call_id: `call_429_${suffix}` });
    assert.match(rateLimited.text, /FAILED: Rate limited \(429\)/);
    assert.match(rateLimited.text, /\[error rate_limit_error\] Rate limit reached/);
    assert.match(rateLimited.text, /Cost: no charge/);

    const expired = await tool(client, "get_call", { call_id: `call_expired_${suffix}` });
    assert.match(expired.text, /## Prompt\nExpired: removed by the project's 7-day body retention\./);
    const metadataOnly = await tool(client, "get_call", { call_id: `call_lookalike_${suffix}` });
    assert.match(metadataOnly.text, /Not captured: this project records metadata only/);

    const runs = await tool(client, "find_runs", { failed_only: true, since: "1h" });
    assert.match(runs.text, new RegExp(`^1 failed run in Atlas[\\s\\S]*run_bad_${suffix} "research"`));
    assert.doesNotMatch(runs.text, new RegExp(`run_ok_${suffix}`));

    const run = await tool(client, "get_run", { run_id: `run_bad_${suffix}` });
    assert.equal(run.isError, false, run.text);
    assert.match(run.text, /FAILED \(the run's root span errored\)/);
    assert.match(run.text, /\nagent researcher · ERROR ToolError[^\n]*\n  tool web_search · ok[^\n]*\n    call gpt-4o-mini · FAILED: Rate limited \(429\)[^\n]*← first failure/);
    assert.match(run.text, new RegExp(`First failure: call call_429_${suffix}`));

    const errors = await tool(client, "recent_errors", { since: "1h" });
    assert.match(errors.text, /1 failed calls of 4/);
    assert.match(errors.text, new RegExp(`openai/gpt-4o-mini · Rate limited \\(429\\) · 1 calls in 1 runs .* sample run run_bad_${suffix}`));
    assert.match(errors.text, /agent researcher · ToolError/);

    const costs = await tool(client, "cost_breakdown", { group_by: "feature", since: "1h" });
    assert.match(costs.text, /Cost by feature in Atlas · last 1h/);
    assert.match(costs.text, /summarize · \$0\.0012/);
    const byRelease = await tool(client, "cost_breakdown", { group_by: "release", since: "1h" });
    assert.match(byRelease.text, /1\.4\.2/);

    const sites = await tool(client, "hot_call_sites");
    assert.equal(sites.isError, false, sites.text);

    const missing = await tool(client, "get_call", { call_id: "no-such-call" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Not found/);
  } finally {
    await client.close();
  }
});

test("MCP: a viewer's token gets the console's redaction, no prompts, responses or code", { skip: !canRun }, async () => {
  const { secret } = await mintToken(viewer, "viewer");
  // The REST read the tool makes is exactly what the console's session gets.
  const viaToken = await call(`/api/v1/projects/${projectA}/events/call_ok_${suffix}`, { bearer: secret });
  const viaConsole = await call(`/api/v1/projects/${projectA}/events/call_ok_${suffix}`, { cookie: session(viewer, "viewer") });
  assert.equal(viaToken.status, 200);
  assert.deepEqual(viaToken.body, viaConsole.body);
  assert.equal(viaToken.body.event.request_body, undefined);
  assert.equal(viaToken.body.event.bl_file, undefined);

  const client = await mcp(secret);
  try {
    const detail = await tool(client, "get_call", { call_id: `call_ok_${suffix}`, include: ["messages", "raw", "frames", "metadata"] });
    assert.equal(detail.isError, false, detail.text);
    for (const secretText of [SYSTEM, ANSWER, SOURCE_LINE.trim(), "summarize.ts", "turn 3", "chat.completions"]) {
      assert.ok(!detail.text.includes(secretText), `viewer output must not include ${secretText}`);
    }
    assert.match(detail.text, /## Call site\nHidden: your role \(Viewer\)/);
    assert.match(detail.text, /## Prompt\nHidden: your role \(Viewer\)/);
    assert.match(detail.text, /Cost: \$0\.0012/, "costs are still visible");

    const list = await tool(client, "find_calls", { since: "1h" });
    assert.ok(!list.text.includes("summarize.ts"));
    assert.match(list.text, /File\/function hidden/);
    const filtered = await tool(client, "find_calls", { file: "summarize.ts" });
    assert.equal(filtered.isError, true, "a file filter that can't apply is an error, not a silent full list");

    const run = await tool(client, "get_run", { run_id: `run_bad_${suffix}` });
    assert.ok(!run.text.includes("summarize.ts"));
    const errors = await tool(client, "recent_errors", { since: "1h" });
    assert.ok(!errors.text.includes("summarize.ts"));
    const grouped = await tool(client, "cost_breakdown", { group_by: "function" });
    assert.equal(grouped.isError, true);
  } finally {
    await client.close();
  }
});

test("MCP needs a token, and can be turned off", { skip: !canRun }, async () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const withCookie = await call("/mcp", { method: "POST", cookie: session(owner, "owner"), body: init });
  assert.equal(withCookie.status, 401, "a console session is not an agent token");
  const { secret } = await mintToken(owner, "owner");
  const get = await call("/mcp", { bearer: secret });
  assert.equal(get.status, 405);
  process.env["COSTKEY_MCP_ENABLED"] = "false";
  try {
    assert.equal((await call("/mcp", { method: "POST", bearer: secret, body: init })).status, 404);
  } finally {
    delete process.env["COSTKEY_MCP_ENABLED"];
  }
});
