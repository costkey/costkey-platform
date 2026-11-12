import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import pg from "pg";
import bcrypt from "bcryptjs";
import {
  ensurePlatformSchema,
} from "../platform-storage.js";
import {
  canAccessProject,
  normalizeRole,
} from "../permissions.js";
import { createTeamsRouter } from "../teams.js";
import { createSavedViewsRouter } from "../saved-views.js";
import { createPlatformRouter } from "../platform.js";
import { createPrivacyRouter, createIngestRuntimeConfigRouter } from "../privacy.js";
import { authMiddleware, createAuthRouter } from "../auth.js";
import { runRetention } from "../retention.js";
import { applyStripeWebhookEvent, createSubscriptionRouter } from "../subscription.js";

const connectionString = process.env["PLATFORM_TEST_DATABASE_URL"] ?? process.env["ACCEPTANCE_DATABASE_URL"];

type TestUser = { id: string; email: string; name: string; orgId: string; role: string };

function identifier(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

async function serve(router: express.Router, user?: TestUser): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      (req as RequestWithUser).user = user;
      next();
    });
  }
  app.use(router);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

interface RequestWithUser extends express.Request {
  user?: TestUser;
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

async function makeScopedPool(): Promise<{ pool: pg.Pool; schema: string; drop: () => Promise<void> }> {
  assert.ok(connectionString);
  const schema = `platform_test_${randomBytes(6).toString("hex")}`;
  const bootstrap = new pg.Pool({ connectionString });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  await bootstrap.end();

  const scoped = new URL(connectionString);
  scoped.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new pg.Pool({ connectionString: scoped.toString(), max: 8 });
  return {
    pool,
    schema,
    drop: async () => {
      await pool.end();
      const cleanup = new pg.Pool({ connectionString });
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await cleanup.end();
    },
  };
}

test("platform PostgreSQL lifecycle and HTTP boundaries", { skip: !connectionString }, async () => {
  const { pool, drop } = await makeScopedPool();
  const closers: Array<() => Promise<void>> = [];
  const open = async (router: express.Router, user?: TestUser) => {
    const handle = await serve(router, user);
    closers.push(handle.close);
    return handle;
  };
  const orgId = "org_platform_test";
  const otherOrgId = "org_platform_other";
  const projectId = "proj_platform_one";
  const secondProjectId = "proj_platform_two";
  const otherProjectId = "proj_platform_other";
  const owner: TestUser = { id: "usr_platform_owner", email: "owner@platform.test", name: "Owner", orgId, role: "owner" };
  const legacy: TestUser = { id: "usr_platform_legacy", email: "legacy@platform.test", name: "Legacy", orgId, role: "member" };
  const developer: TestUser = { id: "usr_platform_developer", email: "developer@platform.test", name: "Developer", orgId, role: "developer" };
  const viewer: TestUser = { id: "usr_platform_viewer", email: "viewer@platform.test", name: "Viewer", orgId, role: "viewer" };
  const otherOwner: TestUser = { id: "usr_platform_other", email: "other@platform.test", name: "Other", orgId: otherOrgId, role: "owner" };
  const passwordHash = await bcrypt.hash("platform-pass", 4);

  try {
    await pool.query(`
      CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT,
        name TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id), role TEXT NOT NULL DEFAULT 'member',
        github_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        org_id TEXT NOT NULL REFERENCES orgs(id), auth_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(),
        provider TEXT NOT NULL DEFAULT 'unknown', model TEXT, request_model TEXT, pricing_id TEXT,
        cost_basis TEXT NOT NULL DEFAULT 'unknown', cost_source TEXT, cost_currency TEXT NOT NULL DEFAULT 'USD',
        duration_ms DOUBLE PRECISION, trace_id TEXT, trace_name TEXT, charge_id TEXT,
        bl_file TEXT, bl_function TEXT, bl_line INTEGER, status_code INTEGER, lifecycle_state TEXT,
        call_site_raw TEXT, call_site_frames JSONB,
        event_type TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
        execution_id TEXT, group_id TEXT, group_name TEXT, group_kind TEXT, phase TEXT, case_id TEXT,
        feature_source TEXT, feature_mapping_id TEXT, feature_mapping_action_id TEXT, feature_original TEXT,
        request_body JSONB, response_body JSONB, system_prompt TEXT, metadata JSONB, configuration JSONB,
        context JSONB, usage_event JSONB, cost_usd DOUBLE PRECISION,
        content_status TEXT NOT NULL DEFAULT 'unknown',
        release TEXT, cache_read_tokens INTEGER, cache_creation_tokens INTEGER, reasoning_tokens INTEGER,
        frames JSONB
      );
      CREATE TABLE call_site_stats (project_id TEXT NOT NULL, call_site_key TEXT NOT NULL, model TEXT, PRIMARY KEY(project_id, call_site_key, model));
      CREATE TABLE custom_providers (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, hostname TEXT NOT NULL,
        usage_input_path TEXT, usage_output_path TEXT, model_path TEXT, enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE alerts (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), project_id TEXT REFERENCES projects(id),
        type TEXT NOT NULL, threshold DOUBLE PRECISION, channel TEXT NOT NULL DEFAULT 'webhook', webhook_url TEXT,
        enabled BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE team_invites (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
        invited_by TEXT NOT NULL REFERENCES users(id), token TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ,
        accepted_by TEXT REFERENCES users(id), revoked_at TIMESTAMPTZ, revoked_by TEXT REFERENCES users(id),
        resent_count INTEGER NOT NULL DEFAULT 0, last_resent_at TIMESTAMPTZ
      );
      CREATE TABLE migrations (name TEXT PRIMARY KEY, ran_at TIMESTAMPTZ DEFAULT NOW());
    `);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Platform Test','platform-test'),($2,'Other Test','other-test')", [orgId, otherOrgId]);
    await pool.query(
      `INSERT INTO projects(id,name,org_id,auth_key) VALUES
       ($1,'One',$3,'key-platform-one'),($2,'Two',$3,'key-platform-two'),($4,'Other',$5,'key-platform-other')`,
      [projectId, secondProjectId, orgId, otherProjectId, otherOrgId],
    );
    await pool.query(
      `INSERT INTO users(id,email,password_hash,name,org_id,role) VALUES
       ($1,$2,$3,$4,$5,$6),($7,$8,$3,'Legacy',$5,'member'),($9,$10,$3,'Developer',$5,'developer'),
       ($11,$12,$3,'Viewer',$5,'viewer'),($13,$14,$3,'Other Owner',$15,'owner')`,
      [owner.id, owner.email, passwordHash, owner.name, orgId, owner.role,
        legacy.id, legacy.email, developer.id, developer.email, viewer.id, viewer.email,
        otherOwner.id, otherOwner.email, otherOrgId],
    );

    await ensurePlatformSchema(pool);
    assert.equal(normalizeRole("member"), "developer");
    assert.equal((await pool.query("SELECT role FROM users WHERE id = $1", [legacy.id])).rows[0].role, "developer");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM project_memberships WHERE user_id = $1", [legacy.id])).rows[0].count, 2);
    await pool.query("DELETE FROM project_memberships WHERE user_id = $1 AND project_id = $2", [legacy.id, secondProjectId]);
    await ensurePlatformSchema(pool);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM project_memberships WHERE user_id = $1 AND project_id = $2", [legacy.id, secondProjectId])).rows[0].count, 0, "restart must not regrant a revoked assignment");
    await pool.query(
      `INSERT INTO project_memberships(project_id,user_id,assigned_by) VALUES ($1,$2,$3),($1,$4,$3) ON CONFLICT DO NOTHING`,
      [projectId, developer.id, owner.id, viewer.id],
    );
    assert.equal(await canAccessProject(pool, viewer, projectId), true);
    assert.equal(await canAccessProject(pool, viewer, secondProjectId), false);

    // Shared views are readable by an assigned Viewer but personal views and
    // foreign projects remain private. No copied URL is an access grant.
    const developerServer = await open(createSavedViewsRouter(pool), developer);
    const shared = await request(developerServer.url, "/api/v1/saved-views", { method: "POST", body: JSON.stringify({ name: "Shared costs", visibility: "workspace", projectId, definition: { model: "gpt-4o" } }) });
    assert.equal(shared.status, 201);
    const sharedId = shared.body.view.id as string;
    const personal = await request(developerServer.url, "/api/v1/saved-views", { method: "POST", body: JSON.stringify({ name: "Personal", projectId, definition: { provider: "openai" } }) });
    assert.equal(personal.status, 201);
    const viewerServer = await open(createSavedViewsRouter(pool), viewer);
    assert.equal((await request(viewerServer.url, `/api/v1/saved-views/${sharedId}`)).status, 200);
    assert.equal((await request(viewerServer.url, `/api/v1/saved-views/${personal.body.view.id}`)).status, 404);
    const ownerViews = await open(createSavedViewsRouter(pool), owner);
    const foreign = await request(ownerViews.url, "/api/v1/saved-views", { method: "POST", body: JSON.stringify({ name: "Second project", visibility: "workspace", projectId: secondProjectId, definition: {} }) });
    assert.equal(foreign.status, 201);
    const foreignView = await request(viewerServer.url, `/api/v1/saved-views/${foreign.body.view.id}`);
    assert.equal(foreignView.status, 404);

    const ownerSettings = await open(createPlatformRouter(pool), owner);
    const defaults = await request(ownerSettings.url, "/api/v1/workspace/settings");
    assert.equal(defaults.status, 200);
    assert.equal(defaults.body.settings.timezone, "UTC");
    const changedSettings = await request(ownerSettings.url, "/api/v1/workspace/settings", { method: "PATCH", body: JSON.stringify({ timezone: "Asia/Kolkata", reportingCurrency: "INR" }) });
    assert.equal(changedSettings.status, 200);
    assert.equal(changedSettings.body.settings.fx.available, false, "INR must remain unavailable without an explicit FX basis");
    const viewerSettings = await open(createPlatformRouter(pool), viewer);
    assert.equal((await request(viewerSettings.url, "/api/v1/workspace/settings", { method: "PATCH", body: JSON.stringify({ timezone: "UTC" }) })).status, 403);

    // Empty project assignment is preserved through invitation acceptance and
    // does not hand an invited Viewer a DSN.
    const ownerTeams = await open(createTeamsRouter(pool), owner);
    const invite = await request(ownerTeams.url, "/api/v1/team/invite", { method: "POST", body: JSON.stringify({ email: "invitee@platform.test", role: "viewer", projectIds: [] }) });
    assert.equal(invite.status, 201);
    const inviteToken = new URL(invite.body.inviteUrl).pathname.split("/").pop();
    assert.ok(inviteToken);
    const invitePreview = await request(ownerTeams.url, `/api/v1/team/invite-preview/${encodeURIComponent(inviteToken)}`);
    assert.equal(invitePreview.status, 200);
    assert.equal(invitePreview.body.invitation.workspace.name, "Platform Test");
    assert.equal(invitePreview.body.invitation.inviter.name, owner.name);
    assert.equal(invitePreview.body.invitation.role, "viewer");
    assert.deepEqual(invitePreview.body.invitation.projects, [], "explicitly empty project scope must stay empty");
    const signupInvite = await request(ownerTeams.url, "/api/v1/team/invite", { method: "POST", body: JSON.stringify({ email: "newinvite@platform.test", role: "viewer" }) });
    assert.equal(signupInvite.status, 201);
    assert.deepEqual(signupInvite.body.projectIds, [], "omitted project scope must default to no projects");
    await pool.query("INSERT INTO users(id,email,password_hash,name,org_id,role) VALUES ($1,$2,$3,$4,$5,$6)", ["usr_platform_invitee", "invitee@platform.test", passwordHash, "Invitee", orgId, "viewer"]);
    const token = inviteToken!;
    assert.ok(token);
    const invitee: TestUser = { id: "usr_platform_invitee", email: "invitee@platform.test", name: "Invitee", orgId, role: "viewer" };
    const inviteeTeams = await open(createTeamsRouter(pool), invitee);
    const accepted = await request(inviteeTeams.url, "/api/v1/team/accept-invite", { method: "POST", body: JSON.stringify({ token }) });
    assert.equal(accepted.status, 200);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM project_memberships WHERE user_id = $1", [invitee.id])).rows[0].count, 0);

    const authApp = express();
    authApp.use(express.json());
    authApp.use(authMiddleware(pool));
    authApp.use(createAuthRouter(pool));
    const authServer = await open(authApp as unknown as express.Router);
    const signedUp = await request(authServer.url, "/auth/signup", { method: "POST", body: JSON.stringify({ email: "newinvite@platform.test", password: "platform-pass", name: "New Invitee", orgName: "Ignored", inviteToken: new URL(signupInvite.body.inviteUrl).pathname.split("/").pop() }) });
    assert.equal(signedUp.status, 201);
    assert.equal(signedUp.body.user.role, "viewer");
    assert.equal(signedUp.body.dsn, null, "invited Viewer signup must not return a DSN");
    assert.equal(signedUp.body.project, null, "explicitly empty project assignment must not fall back to the first project");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM project_memberships WHERE user_id = (SELECT id FROM users WHERE email = 'newinvite@platform.test')")).rows[0].count, 0);
    const loggedIn = await request(authServer.url, "/auth/login", { method: "POST", body: JSON.stringify({ email: viewer.email, password: "platform-pass" }) });
    assert.equal(loggedIn.status, 200);
    const viewerMe = await request(authServer.url, "/auth/me", { headers: { authorization: `Bearer ${loggedIn.body.token}` } });
    assert.equal(viewerMe.status, 200);
    assert.equal(viewerMe.body.projects[0].authKey, null, "Viewer auth/me must not expose a DSN credential");
    assert.equal(viewerMe.body.workspaceSettings.timezone, "Asia/Kolkata");
    assert.equal(viewerMe.body.workspaceSettings.reportingCurrency, "INR");
    assert.equal(viewerMe.body.workspaceSettings.fx.available, false);

    const subscriptionServer = await open(createSubscriptionRouter(pool), owner);
    const previousStripeSecret = process.env["STRIPE_SECRET_KEY"];
    const previousStripePrice = process.env["COSTKEY_STRIPE_PRICE_ID"];
    delete process.env["STRIPE_SECRET_KEY"];
    delete process.env["COSTKEY_STRIPE_PRICE_ID"];
    try {
      const subscription = await request(subscriptionServer.url, "/api/v1/subscription");
      assert.equal(subscription.status, 200);
      assert.equal(subscription.body.subscription.status, "not_configured");
      const checkoutUnavailable = await request(subscriptionServer.url, "/api/v1/subscription/checkout", { method: "POST", body: "{}" });
      assert.equal(checkoutUnavailable.status, 503);
      assert.equal(checkoutUnavailable.body.code, "billing_unconfigured");
    } finally {
      if (previousStripeSecret === undefined) delete process.env["STRIPE_SECRET_KEY"];
      else process.env["STRIPE_SECRET_KEY"] = previousStripeSecret;
      if (previousStripePrice === undefined) delete process.env["COSTKEY_STRIPE_PRICE_ID"];
      else process.env["COSTKEY_STRIPE_PRICE_ID"] = previousStripePrice;
    }

    const configServer = await open(createIngestRuntimeConfigRouter(pool));
    const config = await request(configServer.url, `/api/v1/projects/${projectId}/config`, { headers: { authorization: "Bearer key-platform-one" } });
    assert.equal(config.status, 200);
    assert.equal(config.body.capture.mode, "text");
    assert.equal(typeof config.body.capture.bodyCaptureEnabled, "boolean");

    const privacyServer = await open(createPrivacyRouter(pool), owner);
    await pool.query(
      `INSERT INTO events(id,project_id,timestamp,request_body,content_status)
       VALUES ('evt_user_delete',$1,NOW(),'{"prompt":"delete me"}','captured')`,
      [projectId],
    );
    const deleted = await request(privacyServer.url, `/api/v1/projects/${projectId}/privacy/delete-content`, { method: "POST", body: JSON.stringify({ confirmProjectId: projectId }) });
    assert.equal(deleted.status, 200);
    const deletedRow = (await pool.query("SELECT request_body,content_status FROM events WHERE id = 'evt_user_delete'")).rows[0];
    assert.equal(deletedRow.request_body, null);
    assert.equal(deletedRow.content_status, "redacted", "explicit user deletion must remain distinguishable from expiry");

    // Real retention run: body expiry is independent of 30-day detail purge;
    // native usage/provenance and business context survive body redaction.
    await pool.query(`
      CREATE TABLE usage_components (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(),
        charge_id TEXT, component_id TEXT, caller_id TEXT, context JSONB, trace_id TEXT, execution_id TEXT, group_id TEXT,
        phase TEXT, component TEXT NOT NULL DEFAULT 'custom', provider TEXT NOT NULL DEFAULT 'unknown', model TEXT,
        unit_kind TEXT, unit_value DOUBLE PRECISION, unit TEXT, amount DOUBLE PRECISION, currency TEXT NOT NULL DEFAULT 'USD',
        amount_kind TEXT NOT NULL DEFAULT 'reported', aggregation TEXT NOT NULL DEFAULT 'delta', revision INTEGER,
        pricing_id TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, accounting_at TIMESTAMPTZ, metadata JSONB
      );
      CREATE TABLE traces (id TEXT, project_id TEXT NOT NULL, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), context JSONB);
      CREATE TABLE executions (id TEXT, project_id TEXT NOT NULL, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), configuration JSONB, context JSONB);
      CREATE TABLE groups (id TEXT, project_id TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), metadata JSONB);
      CREATE TABLE daily_cost_aggregates (project_id TEXT NOT NULL, day DATE NOT NULL, known_cost_usd DOUBLE PRECISION);
    `);
    await pool.query(
      `UPDATE project_settings SET capture_mode = 'text', body_capture_enabled = TRUE, body_retention_days = 7, metadata_retention_days = 30, aggregate_retention_days = 395 WHERE project_id = $1`,
      [projectId],
    );
    const now = new Date();
    const eightDaysAgo = new Date(now.getTime() - 8 * 86_400_000);
    const fortyDaysAgo = new Date(now.getTime() - 40 * 86_400_000);
    const fourHundredDaysAgo = new Date(now.getTime() - 400 * 86_400_000);
    await pool.query(
      `INSERT INTO events(id,project_id,timestamp,created_at,request_body,response_body,system_prompt,metadata,configuration,context,usage_event,cost_usd,content_status)
       VALUES ('evt_body_only',$1,$2,$2,'{"prompt":"private"}','{"response":"private"}','private','{"prompts":["private"],"raw":{"secret":"private"}}','{"instructions":"private"}','{"feature":"search","customer":"customer-1","traceId":"trace-1","secret":"private"}','{"usage":{"seconds":2},"pricingId":"price-1"}',1,'captured'),
              ('evt_detail_old',$1,$3,$3,NULL,NULL,NULL,'{"safe":"detail"}',NULL,'{"feature":"search"}',NULL,2,'unknown')`,
      [projectId, eightDaysAgo, fortyDaysAgo],
    );
    await pool.query(
      `INSERT INTO usage_components(id,project_id,observed_at,created_at,metadata,context)
       VALUES ('usage_body_only',$1,$2,$2,'{"usage":{"seconds":2},"pricingId":"price-1","metadata":{"prompt":"private","feature":"search"}}','{"feature":"search","customer":"customer-1","secret":"private"}')`,
      [projectId, eightDaysAgo],
    );
    await pool.query("INSERT INTO daily_cost_aggregates(project_id,day,known_cost_usd) VALUES ($1,$2,2)", [projectId, fourHundredDaysAgo]);
    await pool.query("INSERT INTO daily_cost_aggregate_checkpoints(project_id,through_day,source_created_before,generation) VALUES ($1,$2,$3,1) ON CONFLICT (project_id) DO UPDATE SET through_day=EXCLUDED.through_day, source_created_before=EXCLUDED.source_created_before", [projectId, now.toISOString().slice(0, 10), new Date(now.getTime() - 3_600_000)]);
    await pool.query("UPDATE project_settings SET capture_mode = 'metadata', body_capture_enabled = FALSE, body_retention_days = 7, metadata_retention_days = 30, aggregate_retention_days = 395 WHERE project_id = $1", [secondProjectId]);
    await pool.query("INSERT INTO events(id,project_id,timestamp,created_at,request_body,context,content_status) VALUES ('evt_second_body',$1,$2,$2,'{\"prompt\":\"private\"}','{\"feature\":\"second\"}','captured')", [secondProjectId, eightDaysAgo]);
    const retention = await runRetention(pool, now, orgId);
    assert.equal(retention.blockedProjects?.length ?? 0, 0);
    const bodyRow = (await pool.query("SELECT request_body,response_body,system_prompt,metadata,context,cost_usd,content_status FROM events WHERE id = 'evt_body_only'")).rows[0];
    assert.equal(bodyRow.request_body, null);
    assert.deepEqual(bodyRow.metadata, {});
    assert.equal(bodyRow.context.feature, "search");
    assert.equal(bodyRow.context.customer, "customer-1");
    assert.equal(bodyRow.context.secret, undefined);
    assert.equal(Number(bodyRow.cost_usd), 1, "body purge must preserve typed pricing");
    assert.equal(bodyRow.content_status, "expired", "body purge must record an explicit expired status");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM events WHERE id = 'evt_detail_old'")).rows[0].count, 0);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM daily_cost_aggregates WHERE project_id = $1", [projectId])).rows[0].count, 0);
    const usageRow = (await pool.query("SELECT metadata,context FROM usage_components WHERE id = 'usage_body_only'")).rows[0];
    assert.equal(usageRow.metadata.usage.seconds, 2);
    assert.equal(usageRow.metadata.pricingId, "price-1");
    assert.equal(usageRow.metadata.metadata.prompt, undefined);
    assert.equal(usageRow.context.customer, "customer-1");
    assert.equal((await pool.query("SELECT request_body FROM events WHERE id = 'evt_second_body'")).rows[0].request_body, null, "body purge must not depend on a 30-day detail row");

    // An incomplete checkpoint leaves detail and cost untouched while still
    // allowing an independent body redaction on the next run.
    await pool.query("INSERT INTO events(id,project_id,timestamp,created_at,cost_usd) VALUES ('evt_fenced',$1,$2,$2,3)", [projectId, fortyDaysAgo]);
    await pool.query("UPDATE daily_cost_aggregate_checkpoints SET through_day = $2 WHERE project_id = $1", [projectId, new Date(now.getTime() - 100 * 86_400_000).toISOString().slice(0, 10)]);
    const blocked = await runRetention(pool, now, orgId);
    assert.ok(blocked.blockedProjects?.includes(projectId));
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM events WHERE id = 'evt_fenced'")).rows[0].count, 1);

    // Exports use the canonical call/usage cohort, apply repeated OR filters
    // within a dimension and AND across dimensions, and ignore explorer
    // pagination rather than silently returning a partial dataset.
    await pool.query(
      `INSERT INTO events(
         id,project_id,timestamp,provider,model,request_model,cost_usd,cost_basis,cost_source,cost_currency,
         trace_id,trace_name,bl_file,bl_function,status_code,context,request_body,content_status
       ) VALUES
         ('evt_export_one',$1,NOW() - INTERVAL '1 minute','openai','gpt-4o','gpt-4o',1,'estimated','pricing_table','USD','trace-export','Export trace','src/app.ts','summarize',200,'{"feature":"search","customer":"customer-1","environment":"production"}','{"prompt":"private export"}','captured'),
         ('evt_export_two',$1,NOW() - INTERVAL '2 minutes','openai','gpt-4o','gpt-4o',NULL,'unknown',NULL,'USD','trace-unpriced','Unpriced trace','src/app.ts','summarize',500,'{"feature":"search","customer":"customer-1","environment":"production"}',NULL,'not_available'),
         ('evt_export_three',$1,NOW() - INTERVAL '3 minutes','anthropic','claude-3','claude-3',2,'reported','provider','USD','trace-other','Other trace','src/other.ts','other',200,'{"feature":"other","customer":"customer-2","environment":"development"}',NULL,'metadata_only'),
         ('evt_export_expired',$1,NOW() - INTERVAL '4 minutes','openai','gpt-4o','gpt-4o',3,'estimated','pricing_table','USD','trace-expired','Expired trace','src/app.ts','summarize',200,'{"feature":"search","customer":"customer-1","environment":"production"}','{"prompt":"expired"}','expired')`,
      [projectId],
    );
    await pool.query(
      `INSERT INTO usage_components(id,project_id,observed_at,accounting_at,provider,model,amount,currency,amount_kind,aggregation,active,metadata,context)
       VALUES ('usage_export_one',$1,NOW() - INTERVAL '30 seconds',NOW() - INTERVAL '30 seconds','openai','gpt-4o',2,'USD','reported','delta',TRUE,'{"pricingId":"usage-price"}','{"feature":"search","customer":"customer-1","environment":"production"}')`,
      [projectId],
    );
    const exportOwner = await open(createPlatformRouter(pool), owner);
    const broadExport = await request(exportOwner.url, `/api/v1/projects/${projectId}/export?format=json&feature=search&provider=openai&provider=anthropic&customer=customer-1&environment=production&limit=1&offset=999`);
    assert.equal(broadExport.status, 200);
    assert.equal(broadExport.body.matchedCount, 4, "repeated dimensions must OR while remaining dimensions AND");
    assert.equal(broadExport.body.scope.paginationApplied, false);
    assert.ok(broadExport.body.events.some((row: { record_type: string }) => row.record_type === "usage"), "explicit usage must be exported with canonical charges");
    await pool.query(
      `INSERT INTO events(id,project_id,timestamp,provider,model,cost_usd,cost_basis,cost_source,cost_currency,context,content_status)
       SELECT 'evt_export_bulk_' || n, $1, NOW() - (n || ' seconds')::interval,
              'openai', 'gpt-4o', 0.01, 'estimated', 'pricing_table', 'USD',
              '{"feature":"bulk","customer":"bulk","environment":"production"}'::jsonb, 'metadata_only'
       FROM generate_series(1, 1001) AS n`,
      [projectId],
    );
    const bulkExport = await request(exportOwner.url, `/api/v1/projects/${projectId}/export?format=json&feature=bulk&limit=1`);
    assert.equal(bulkExport.status, 200);
    assert.equal(bulkExport.body.matchedCount, 1001, "exports must stream every matching row beyond one writer chunk");
    assert.equal(bulkExport.body.events[0].id, "evt_export_bulk_1");
    assert.equal(bulkExport.body.events.at(-1).id, "evt_export_bulk_1001");
    const bulkCsv = await request(exportOwner.url, `/api/v1/projects/${projectId}/export?format=csv&feature=bulk&limit=1`);
    assert.equal(bulkCsv.status, 200);
    const csvLines = String(bulkCsv.body).trim().split("\n");
    assert.equal(csvLines.length, 1002, "CSV streaming must emit one header and every matching row");
    assert.equal(csvLines.filter((line) => line.startsWith("id,charge_id,")).length, 1);
    const exactExport = await request(exportOwner.url, `/api/v1/projects/${projectId}/export?format=json&function=${encodeURIComponent("src/app.ts:summarize")}&feature=search&coverage=complete&status=200&q=trace-export&limit=1`);
    assert.equal(exactExport.status, 200);
    assert.equal(exactExport.body.matchedCount, 1);
    assert.equal(exactExport.body.events[0].id, "evt_export_one");
    const ownerContent = await request(exportOwner.url, `/api/v1/projects/${projectId}/export?format=json&includeContent=true&contentStatus=expired`);
    assert.equal(ownerContent.status, 200);
    assert.equal(ownerContent.body.events[0].request_body, null, "expired content must not be restored by an authorized export");
    const viewerExport = await open(createPlatformRouter(pool), viewer);
    const viewerMetadata = await request(viewerExport.url, `/api/v1/projects/${projectId}/export?format=json&feature=search`);
    assert.equal(viewerMetadata.status, 200);
    assert.equal(viewerMetadata.body.events[0].content_status, "restricted");
    assert.equal("file_name" in viewerMetadata.body.events[0], false);
    assert.equal((await request(viewerExport.url, `/api/v1/projects/${projectId}/export?format=json&includeContent=true`)).status, 403);

    const checkout = await applyStripeWebhookEvent(pool, {
      id: "evt_checkout", type: "checkout.session.completed", created: Math.floor((now.getTime() - 10_000) / 1000),
      data: { object: { metadata: { org_id: orgId }, customer: "cus_platform", subscription: "sub_platform" } },
    });
    assert.equal(checkout.applied, true);
    assert.equal((await pool.query("SELECT status FROM subscriptions WHERE org_id = $1", [orgId])).rows[0].status, "checkout_completed");
    await applyStripeWebhookEvent(pool, {
      id: "evt_active", type: "customer.subscription.created", created: Math.floor((now.getTime() + 1_000) / 1000),
      data: { object: { metadata: { org_id: orgId }, id: "sub_platform", customer: "cus_platform", status: "active", cancel_at_period_end: false } },
    });
    assert.equal((await pool.query("SELECT status FROM subscriptions WHERE org_id = $1", [orgId])).rows[0].status, "active");
    assert.equal((await applyStripeWebhookEvent(pool, {
      id: "evt_active", type: "customer.subscription.created", created: Math.floor((now.getTime() + 1_000) / 1000),
      data: { object: { metadata: { org_id: orgId }, id: "sub_platform", customer: "cus_platform", status: "active" } },
    })).applied, false, "duplicate provider event must be idempotent");
    await applyStripeWebhookEvent(pool, {
      id: "evt_old_cancel", type: "customer.subscription.deleted", created: Math.floor((now.getTime() - 100_000) / 1000),
      data: { object: { metadata: { org_id: orgId }, id: "sub_platform", customer: "cus_platform", status: "canceled" } },
    });
    assert.equal((await pool.query("SELECT status FROM subscriptions WHERE org_id = $1", [orgId])).rows[0].status, "active", "old provider event must not revive cancellation state");
    await applyStripeWebhookEvent(pool, {
      id: "evt_cancel", type: "customer.subscription.deleted", created: Math.floor((now.getTime() + 2_000) / 1000),
      data: { object: { metadata: { org_id: orgId }, id: "sub_platform", customer: "cus_platform", status: "canceled" } },
    });
    await applyStripeWebhookEvent(pool, {
      id: "evt_old_active", type: "customer.subscription.updated", created: Math.floor((now.getTime() + 1_000) / 1000),
      data: { object: { metadata: { org_id: orgId }, id: "sub_platform", customer: "cus_platform", status: "active" } },
    });
    assert.equal((await pool.query("SELECT status FROM subscriptions WHERE org_id = $1", [orgId])).rows[0].status, "canceled", "old provider event must not revive a later cancellation");
    await assert.rejects(() => applyStripeWebhookEvent(pool, { id: "evt_unknown", type: "customer.subscription.created", data: { object: { id: "sub_unknown", status: "active" } } }));

    const eventForRollback = { id: "evt_rollback", type: "checkout.session.completed", created: Math.floor((now.getTime() + 10_000) / 1000), data: { object: { metadata: { org_id: orgId }, customer: "cus_rollback" } } };
    await pool.query(`
      CREATE FUNCTION fail_platform_subscription_projection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.provider_customer_id = 'cus_rollback' THEN RAISE EXCEPTION 'synthetic projection failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_platform_subscription_projection BEFORE INSERT OR UPDATE ON subscriptions
      FOR EACH ROW EXECUTE FUNCTION fail_platform_subscription_projection();
    `);
    await assert.rejects(() => applyStripeWebhookEvent(pool, eventForRollback));
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM subscription_events WHERE provider_event_id = 'evt_rollback'")).rows[0].count, 0, "failed projection must roll back the idempotency row");
    await pool.query("DROP TRIGGER fail_platform_subscription_projection ON subscriptions; DROP FUNCTION fail_platform_subscription_projection();");
    assert.equal((await applyStripeWebhookEvent(pool, eventForRollback)).applied, true, "rolled back webhook must be replayable");

    // Ownership transfer is a single locked transaction: concurrent requests
    // cannot produce zero or two owners, and a foreign target is rejected.
    const transferOrgId = "org_platform_transfer";
    const transferOwnerId = "usr_platform_transfer_owner";
    const transferTargetId = "usr_platform_transfer_target";
    const transferRaceOneId = "usr_platform_transfer_race_one";
    const transferRaceTwoId = "usr_platform_transfer_race_two";
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Transfer Test','transfer-test')", [transferOrgId]);
    await pool.query(
      `INSERT INTO users(id,email,password_hash,name,org_id,role) VALUES
       ($1,'transfer-owner@platform.test',$5,'Transfer Owner',$6,'owner'),
       ($2,'transfer-target@platform.test',$5,'Transfer Target',$6,'developer'),
       ($3,'transfer-race-one@platform.test',$5,'Transfer Race One',$6,'viewer'),
       ($4,'transfer-race-two@platform.test',$5,'Transfer Race Two',$6,'viewer')`,
      [transferOwnerId, transferTargetId, transferRaceOneId, transferRaceTwoId, passwordHash, transferOrgId],
    );
    const transferOwner: TestUser = { id: transferOwnerId, email: "transfer-owner@platform.test", name: "Transfer Owner", orgId: transferOrgId, role: "owner" };
    const transferTarget: TestUser = { id: transferTargetId, email: "transfer-target@platform.test", name: "Transfer Target", orgId: transferOrgId, role: "developer" };
    const transferServer = await open(createTeamsRouter(pool), transferOwner);
    const transferred = await request(transferServer.url, "/api/v1/team/transfer-ownership", { method: "POST", body: JSON.stringify({ targetUserId: transferTargetId, confirmTargetUserId: transferTargetId }) });
    assert.equal(transferred.status, 200);
    assert.equal(transferred.body.owner.id, transferTargetId);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE org_id = $1 AND role = 'owner'", [transferOrgId])).rows[0].count, 1);
    assert.equal((await pool.query("SELECT role FROM users WHERE id = $1", [transferOwnerId])).rows[0].role, "admin");
    assert.equal((await pool.query("SELECT action FROM workspace_audit_log WHERE org_id = $1", [transferOrgId])).rows[0].action, "ownership_transferred");
    assert.equal((await request(transferServer.url, "/api/v1/team/transfer-ownership", { method: "POST", body: JSON.stringify({ targetUserId: transferRaceOneId, confirmTargetUserId: transferRaceOneId }) })).status, 409, "a demoted owner's stale transfer must report a conflict");

    const currentTransferOwner: TestUser = { ...transferTarget, role: "owner" };
    const currentTransferServer = await open(createTeamsRouter(pool), currentTransferOwner);
    assert.equal((await request(currentTransferServer.url, "/api/v1/team/transfer-ownership", { method: "POST", body: JSON.stringify({ targetUserId: otherOwner.id, confirmTargetUserId: otherOwner.id }) })).status, 404, "ownership target must be in the same workspace");
    const raceResults = await Promise.all([transferRaceOneId, transferRaceTwoId].map((targetUserId) => request(currentTransferServer.url, "/api/v1/team/transfer-ownership", { method: "POST", body: JSON.stringify({ targetUserId, confirmTargetUserId: targetUserId }) })));
    assert.deepEqual(raceResults.map((result) => result.status).sort((a, b) => a - b), [200, 409], "one concurrent transfer must win and the other must observe the changed owner");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE org_id = $1 AND role = 'owner'", [transferOrgId])).rows[0].count, 1);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM workspace_audit_log WHERE org_id = $1 AND action = 'ownership_transferred'", [transferOrgId])).rows[0].count, 2);

    // Closure is explicit and durable but intentionally non-destructive: its
    // impact snapshot calls out subscription, policy, DSN and data effects.
    const closureOrgId = "org_platform_closure";
    const closureOwnerId = "usr_platform_closure_owner";
    const closureAdminId = "usr_platform_closure_admin";
    const closureProjectId = "proj_platform_closure";
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Closure Test','closure-test')", [closureOrgId]);
    await pool.query(
      `INSERT INTO users(id,email,password_hash,name,org_id,role) VALUES
       ($1,'closure-owner@platform.test',$3,'Closure Owner',$4,'owner'),
       ($2,'closure-admin@platform.test',$3,'Closure Admin',$4,'admin')`,
      [closureOwnerId, closureAdminId, passwordHash, closureOrgId],
    );
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Closure Project',$2,'key-platform-closure')", [closureProjectId, closureOrgId]);
    await pool.query("INSERT INTO subscriptions(org_id,provider,status,amount_cents,currency) VALUES ($1,'stripe','active',1000,'usd')", [closureOrgId]);
    const closureOwner: TestUser = { id: closureOwnerId, email: "closure-owner@platform.test", name: "Closure Owner", orgId: closureOrgId, role: "owner" };
    const closureAdmin: TestUser = { id: closureAdminId, email: "closure-admin@platform.test", name: "Closure Admin", orgId: closureOrgId, role: "admin" };
    const closureServer = await open(createTeamsRouter(pool), closureOwner);
    const impact = await request(closureServer.url, "/api/v1/workspace/closure-impact");
    assert.equal(impact.status, 200);
    assert.equal(impact.body.impact.projects.count, 1);
    assert.equal(impact.body.impact.projects.dsnCount, 1);
    assert.equal(impact.body.impact.subscription.status, "active");
    assert.equal(impact.body.impact.data.deletion, "not_requested");
    assert.equal((await request(closureServer.url, "/api/v1/workspace/closure", { method: "POST", body: JSON.stringify({ confirmOrgId: "wrong", acknowledgeImpact: true }) })).status, 400);
    assert.equal((await request(closureServer.url, "/api/v1/workspace/closure", { method: "POST", body: JSON.stringify({ confirmOrgId: closureOrgId, acknowledgeImpact: false }) })).status, 400);
    const closure = await request(closureServer.url, "/api/v1/workspace/closure", { method: "POST", body: JSON.stringify({ confirmOrgId: closureOrgId, acknowledgeImpact: true }) });
    assert.equal(closure.status, 201);
    assert.equal(closure.body.deletionStarted, false);
    assert.equal(closure.body.impact.subscription.status, "active");
    const repeatedClosure = await request(closureServer.url, "/api/v1/workspace/closure", { method: "POST", body: JSON.stringify({ confirmOrgId: closureOrgId, acknowledgeImpact: true }) });
    assert.equal(repeatedClosure.status, 200);
    assert.equal(repeatedClosure.body.requestId, closure.body.requestId, "retries must not create duplicate closure requests");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM workspace_closure_requests WHERE org_id = $1 AND status = 'requested'", [closureOrgId])).rows[0].count, 1);
    assert.equal((await pool.query("SELECT action FROM workspace_audit_log WHERE org_id = $1", [closureOrgId])).rows[0].action, "closure_requested");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM projects WHERE id = $1", [closureProjectId])).rows[0].count, 1, "closure request must not delete projects");
    assert.equal((await request((await open(createTeamsRouter(pool), closureAdmin)).url, "/api/v1/workspace/closure-impact")).status, 403, "closure impact is owner-only");
  } finally {
    for (const close of closers) await close().catch(() => undefined);
    await drop();
  }
});

test("signup uniquifies a taken workspace slug instead of failing", { skip: !connectionString }, async () => {
  const { pool, drop } = await makeScopedPool();
  try {
    await pool.query(`
      CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE);
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, name TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id), role TEXT NOT NULL DEFAULT 'member');
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id), auth_key TEXT NOT NULL UNIQUE);
      CREATE TABLE workspace_settings (org_id TEXT PRIMARY KEY REFERENCES orgs(id), timezone TEXT, reporting_currency TEXT);
      CREATE TABLE project_settings (project_id TEXT PRIMARY KEY REFERENCES projects(id), capture_mode TEXT, body_capture_enabled BOOLEAN, redaction_enabled BOOLEAN, body_retention_days INTEGER, metadata_retention_days INTEGER, aggregate_retention_days INTEGER, source_access_enabled BOOLEAN);
    `);
    const authApp = express();
    authApp.use(express.json());
    authApp.use(authMiddleware(pool));
    authApp.use(createAuthRouter(pool));
    const handle = await serve(authApp as unknown as express.Router);
    try {
      const first = await request(handle.url, "/auth/signup", { method: "POST", body: JSON.stringify({ email: "first@slug.test", password: "slug-pass-1", name: "First", orgName: "Duplicate Widgets" }) });
      assert.equal(first.status, 201);
      assert.equal(first.body.org.slug, "duplicate-widgets");
      const second = await request(handle.url, "/auth/signup", { method: "POST", body: JSON.stringify({ email: "second@slug.test", password: "slug-pass-2", name: "Second", orgName: "Duplicate Widgets" }) });
      assert.equal(second.status, 201);
      assert.notEqual(second.body.org.slug, first.body.org.slug);
      assert.ok(String(second.body.org.slug).startsWith("duplicate-widgets-"));
    } finally {
      await handle.close();
    }
  } finally {
    await drop();
  }
});
