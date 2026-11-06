import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { ensureAccountingChangeSchema, ensureDailyAggregateSchema, ensureQualityCheckSchema, getPool, initDatabase, migrationRecorded, runOnce, setMigrationLockTimeout, withMigrationLock } from "./db.js";
import { ensureSsoSchema } from "./sso/provision.js";
import { createIngestRouter, loadCallGraphCache } from "./ingest.js";
import { ensureIngestQueueSchema, startIngestWorker, type IngestWorker } from "./ingest-queue.js";
import { createAuthRouter, authMiddleware } from "./auth.js";
import { createSsoRouter, ssoSessionMiddleware } from "./sso/router.js"; // single sign-on
import { reportAuthSettingsAtStartup } from "./sso/config.js"; // single sign-on
import { createInvitePreviewRouter, createTeamsRouter } from "./teams.js";
import { createAlertsRouter, checkAlerts } from "./alerts.js";
import { projectMutationGuard, platformResponseGuards, rateLimit } from "./middleware.js";
import { initAnomalyTable, detectAnomalies } from "./anomaly.js";
import { seedDemoAgentRuns, seedIfEmpty } from "./seed.js";
import { backfillCosts } from "./pricing.js";
import { initPriceCatalog, refreshPriceCatalogIfChanged } from "./price-catalog/sync.js";
import { createSourcemapsRouter } from "./sourcemaps.js";
import { initSourceMaps } from "./sourcemap-resolver.js";
import { configureRequestParsing, requestParseErrorHandler } from "./request-parsing.js";
import { ensurePlatformSchema } from "./platform-storage.js";
import { ensurePolicySchema } from "./policy-storage.js";
import { createPlatformRouter } from "./platform.js";
import { createSdkBudgetCompatibilityRouter } from "./platform.js";
import { createSdkAdmissionRouter } from "./admission.js";
import { createIngestRuntimeConfigRouter, createPrivacyRouter, privacyIngestGuard } from "./privacy.js";
import { createReleasesRouter, ensureReleaseSchema } from "./releases.js";
import { createRetentionRouter, runRetention } from "./retention.js";
import { createSavedViewsRouter } from "./saved-views.js";
import { createNotificationsRouter, runWeeklyDigests } from "./notifications.js";
import { createSubscriptionRouter } from "./subscription.js";
import { refreshAllFindings } from "./findings.js";
import { invalidateOnChange } from "./response-cache.js";
import { reconcileDailyAccounting } from "./accounting.js";
import { startQualityCheckWorker } from "./quality-checks/worker.js";
import { startEmptyRunSweeper } from "./empty-runs.js";
import { seedDemoQualityChecks } from "./quality-checks/seed.js";
import { basePath } from "./public-url.js";
import { apiTokenGuards, createApiTokensRouter } from "./api-tokens.js";
import { createMcpRouter } from "./mcp/index.js";

// Set by the image build from the release tag; "dev" when run from source.
const SERVER_VERSION = process.env["COSTKEY_VERSION"] || "dev";
/** The commit this server was built from, stamped into the image by CI. */
const SERVER_COMMIT = /^[0-9a-f]{7,40}$/i.test(process.env["COSTKEY_COMMIT"] ?? "") ? process.env["COSTKEY_COMMIT"]!.toLowerCase() : null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardDist = path.resolve(__dirname, "../../dashboard/dist");

export interface AppOptions {
  /** Inject a pool for a local harness. The default is the configured app pool. */
  pool?: pg.Pool;
  /** Keep static dashboard routes out of API-only test apps. */
  includeDashboard?: boolean;
  /** Skip all async database startup work; callers can invoke initializeApp explicitly. */
  initialize?: boolean;
  /** Explicitly opt into background jobs in a harness. Defaults to production behavior. */
  startSchedulers?: boolean;
  /** Bind host for local harnesses; production defaults to all interfaces. */
  host?: string;
}

export interface AppRuntime {
  app: Express;
  pool: pg.Pool;
  initialize: () => Promise<void>;
  stopSchedulers: () => void;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] ?? char));
}

/**
 * The console is built once with a relative Vite base ("./assets/...") and
 * learns its base path when served: asset URLs in the shell are anchored at
 * the base path, so they resolve from any route depth, and
 * window.__COSTKEY_BASE__ tells the app where its API and routes live.
 * Lazy chunks load relative to the chunk that imports them.
 */
export function renderDashboardIndex(html: string, base: string): string {
  const anchored = html.replace(/(\s(?:src|href)=["'])\.\//g, `$1${escapeHtmlAttribute(base)}/`);
  const script = `<script>window.__COSTKEY_BASE__=${JSON.stringify(base).replace(/</g, "\\u003c")};</script>`;
  return anchored.replace(/<head>/i, (head) => `${head}\n    ${script}`);
}

function dashboardIndexSender(base: string): (req: express.Request, res: express.Response) => void {
  const indexPath = path.join(dashboardDist, "index.html");
  let cached: { mtimeMs: number; html: string } | null = null;
  return (_req, res) => {
    try {
      const { mtimeMs } = fs.statSync(indexPath);
      if (!cached || cached.mtimeMs !== mtimeMs) {
        cached = { mtimeMs, html: renderDashboardIndex(fs.readFileSync(indexPath, "utf8"), base) };
      }
      res.setHeader("Cache-Control", "no-store, must-revalidate");
      res.type("html").send(cached.html);
    } catch {
      res.status(404).type("text").send("Console not built");
    }
  };
}

function addSpaRoutes(app: Express, includeDashboard: boolean, base: string): void {
  if (!includeDashboard || !fs.existsSync(path.join(dashboardDist, "index.html"))) return;
  const sendIndex = dashboardIndexSender(base);
  // index.html is always rendered for this base path, never sent as a file.
  app.get(["/", "/index.html"], sendIndex);
  app.use(express.static(dashboardDist, {
    index: false,
    setHeaders: (res, filePath) => {
      if (path.basename(filePath) === "index.html") {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
        return;
      }
      if (filePath.startsWith(path.join(dashboardDist, "assets") + path.sep)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));
  console.log("[costkey] Dashboard static files from", dashboardDist);
  // A stale HTML shell must not receive a fresh HTML fallback or a session
  // 401 when its hashed JS chunk is absent. Keep this boundary before auth.
  app.use("/assets", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") { next(); return; }
    const relative = req.path.replace(/^\/+/, "");
    const candidate = path.resolve(dashboardDist, "assets", relative);
    const assetsRoot = path.resolve(dashboardDist, "assets") + path.sep;
    if (!candidate.startsWith(assetsRoot) || !fs.existsSync(candidate)) {
      const contentType = candidate.endsWith(".css") ? "text/css; charset=utf-8"
        : candidate.endsWith(".map") ? "application/json; charset=utf-8"
          : "text/javascript; charset=utf-8";
      res.status(404).type(contentType).send("Asset not found");
      return;
    }
    next();
  });
  const spaRoutes = ["/login", "/signup", "/onboarding", "/settings", "/invite/:token"];
  for (const route of spaRoutes) app.get(route, sendIndex);
}

function addSpaFallback(app: Express, includeDashboard: boolean, base: string): void {
  if (!includeDashboard || !fs.existsSync(path.join(dashboardDist, "index.html"))) return;
  app.get("/{*path}", dashboardIndexSender(base));
}

/**
 * Build the HTTP application without listening, running migrations, seeding or
 * starting timers. This is the stable seam for local acceptance harnesses.
 */
export function createApp(options: AppOptions = {}): Express & AppRuntime {
  const pool = options.pool ?? getPool();
  const base = basePath();
  // Single sign-on: throws for an unknown COSTKEY_AUTH, logs missing settings.
  reportAuthSettingsAtStartup();
  const app = express();
  const schedulerHandles: NodeJS.Timeout[] = [];
  // Ingest goes through the Postgres queue whenever this process runs the
  // workers; harnesses without schedulers store batches in the request.
  const ingestQueue = options.startSchedulers !== false && process.env["COSTKEY_INGEST_QUEUE"] !== "off";
  let ingestWorker: IngestWorker | null = null;
  let initialized = false;
  let initializationError: unknown = null;
  let initialization: Promise<void> | null = null;

  const allowedOrigins = new Set(
    (process.env["COSTKEY_ALLOWED_ORIGINS"]
      ?? "http://localhost:5180,http://127.0.0.1:5180")
      .split(",").map((origin) => origin.trim()).filter(Boolean),
  );
  app.use(cors((req, callback) => {
    const origin = req.headers.origin;
    // The console served by this server is always allowed, whatever its domain.
    let sameOrigin = false;
    try { sameOrigin = Boolean(origin) && new URL(origin!).host === (req.headers["x-forwarded-host"] ?? req.headers.host); } catch { /* not a URL */ }
    if (!origin || sameOrigin || allowedOrigins.has(origin)) callback(null, { credentials: true, origin: true });
    else callback(new Error("Origin is not allowed"));
  }));
  // Preserve the exact signed Stripe bytes before the normal JSON parser runs.
  app.use("/api/v1/billing/webhooks/stripe", express.raw({ type: "application/json", limit: "1mb" }));
  configureRequestParsing(app);
  app.use(requestParseErrorHandler);
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    next();
  });

  const health = (_req: express.Request, res: express.Response) => {
    if (!initialized) {
      res.status(503).json({ status: initializationError ? "error" : "starting", version: SERVER_VERSION, commit: SERVER_COMMIT });
      return;
    }
    res.json({ status: "ok", version: SERVER_VERSION, commit: SERVER_COMMIT });
  };
  app.get(["/health", "/ready"], health);
  addSpaRoutes(app, options.includeDashboard !== false, base);

  // Authentication is non-blocking for SDK and public routes. API routers
  // enforce it where a user identity is required.
  app.use(authMiddleware(pool));
  // Single sign-on: in IAP mode the signed IAP header decides who this is.
  app.use(ssoSessionMiddleware(pool));
  // Personal access tokens: a per-token read limit, and no ingest secrets.
  app.use(apiTokenGuards());

  app.use("/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
  app.use("/auth/signup", rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }));
  // The test-only impersonation seam is still rate-limited so an acceptance
  // misconfiguration cannot become an unbounded credential oracle.
  app.use("/auth/admin/impersonate", rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }));
  app.use("/api/v1/feedback", rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyFn: (req) => String((req as express.Request & { user?: { id?: string } }).user?.id ?? req.ip ?? "unknown"),
  }));
  app.use("/api/v1/events", rateLimit({
    windowMs: 60 * 1000,
    max: 1000,
    keyFn: (req) => req.headers.authorization?.slice(7) ?? req.ip ?? "unknown",
  }));
  app.use("/api/v1/events", privacyIngestGuard(pool));

  // Route-level guards for legacy API mutations. Personal/shared saved-view
  // actions use their own capability checks and are intentionally not covered
  // by this owner/admin guard.
  app.use("/api/v1/projects/:projectId/rotate-key", projectMutationGuard());
  app.use("/api/v1/projects/:projectId/providers", projectMutationGuard());
  app.use("/api/v1/projects/:projectId/budget", projectMutationGuard());
  app.use("/api/v1/projects/:projectId", platformResponseGuards(pool));

  // DSN-only SDK routers must precede every router with a global requireAuth.
  // They are safe to import because admission has no optional email client;
  // the legacy budget/API routers remain lazy until database initialization.
  // A change through the API drops the cached summaries it affects (response-cache.ts).
  app.use(invalidateOnChange());
  app.use(createSdkAdmissionRouter(pool));
  // Coding agents: read-only tokens and the MCP endpoint they use.
  app.use(createApiTokensRouter(pool));
  app.use(createMcpRouter());
  app.use(createSdkBudgetCompatibilityRouter(pool));
  // Single sign-on: /auth/config, OIDC routes, and the password-route guard
  // must precede the password auth router.
  app.use(createSsoRouter(pool));
  app.use(createAuthRouter(pool));
  app.use(createIngestRuntimeConfigRouter(pool));
  app.use(createIngestRouter(pool, { queue: ingestQueue }));
  // Public, token-scoped routes go before routers that require auth globally.
  app.use(createInvitePreviewRouter(pool));
  app.use(createSubscriptionRouter(pool));
  app.use(createPlatformRouter(pool));
  app.use(createPrivacyRouter(pool));
  app.use(createReleasesRouter(pool));
  app.use(createRetentionRouter(pool));
  app.use(createSavedViewsRouter(pool));
  app.use(createNotificationsRouter(pool));
  app.use(createTeamsRouter(pool));
  app.use(createAlertsRouter(pool));
  app.use(createSourcemapsRouter(pool));

  const initialize = async (): Promise<void> => {
    if (initialized) return;
    if (initialization) return initialization;
    initializationError = null;
    initialization = (async () => {
      console.log("[costkey] DATABASE_URL:", process.env["DATABASE_URL"]?.replace(/:[^@]+@/, ":***@") ?? "not set");
      // Schema setup locks tables, so a build runs it once: later boots of the
      // same build (restarts, scale-ups) skip it and serve right away.
      // A supplied pool belongs to a harness and owns its own schema setup;
      // the production pool uses the legacy initializer before platform DDL.
      const schemaStamp = SERVER_COMMIT && !options.pool ? `schema@${SERVER_COMMIT}` : null;
      if (!schemaStamp || !await migrationRecorded(pool, schemaStamp)) {
        if (!options.pool) await initDatabase();
        await ensurePlatformSchema(pool);
        await ensureReleaseSchema(pool);
        await ensurePolicySchema(pool);
        await ensureQualityCheckSchema(pool);
        // Instances boot together, and CREATE TABLE IF NOT EXISTS races: the loser
        // fails on the type the winner has just created, so these take turns.
        await withMigrationLock(pool, (client) => ensureIngestQueueSchema(client));
        // Every table exists from the first boot; nothing is created on first use.
        await ensureSsoSchema(pool);
        await withMigrationLock(pool, (client) => ensureDailyAggregateSchema(client));
        await withMigrationLock(pool, (client) => ensureAccountingChangeSchema(client));
        if (schemaStamp) await pool.query("INSERT INTO migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [schemaStamp]);
      }
      // Rollups taken before changes were tracked may have missed late calls
      // or repricing: mark every stored period once so the scheduler redoes them.
      await runOnce(pool, "refresh_daily_rollup_v1", async () => {
        await pool.query(`
          INSERT INTO accounting_changed_periods (project_id, period_start)
          SELECT DISTINCT project_id, date_bin('15 minutes', timestamp, TIMESTAMPTZ '2000-01-01 00:00:00+00')
          FROM events WHERE timestamp IS NOT NULL
          UNION
          SELECT DISTINCT project_id, date_bin('15 minutes', COALESCE(accounting_at, observed_at), TIMESTAMPTZ '2000-01-01 00:00:00+00')
          FROM usage_components WHERE COALESCE(accounting_at, observed_at) IS NOT NULL
          ON CONFLICT (project_id, period_start) DO NOTHING
        `);
      });
      console.log("[costkey] Database ready");
      await loadCallGraphCache(pool);
      // Demo data is opt-in and never runs in production. Existing customer
      // rows are preserved; an empty production database stays empty until a
      // real signup creates its first workspace/project.
      if (process.env["NODE_ENV"] !== "production" && process.env["COSTKEY_SEED_DEMO"] === "true") {
        await seedIfEmpty(pool);
        await seedDemoAgentRuns(pool);
        // seedIfEmpty may create the first legacy/demo project after the
        // initial additive DDL; backfill its settings without changing rows.
        await ensurePlatformSchema(pool);
        await seedDemoQualityChecks(pool);
      }
      await initSourceMaps();
      await backfillCosts(pool);
      const priceSync = await initPriceCatalog(pool, { schedule: options.startSchedulers !== false })
        .catch((error) => { console.error("[costkey] Price catalog error:", error); return null; });
      if (priceSync) schedulerHandles.push(priceSync);
      await initAnomalyTable(pool);

      const [{ createBudgetsRouter, runBudgetChecks }, { createApiRouter }] = await Promise.all([
        import("./budgets.js"),
        import("./api.js"),
      ]);
      // SDK budget checks precede session-only routers. The legacy API is last
      // so platform project/export routes remain authoritative.
      app.use(createBudgetsRouter(pool));
      app.use(createApiRouter(pool));
      app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
      addSpaFallback(app, options.includeDashboard !== false, base);

      if (options.startSchedulers !== false) {
        const periodic = setInterval(() => {
          void checkAlerts(pool);
          void detectAnomalies(pool);
          void runBudgetChecks(pool);
          void refreshAllFindings(pool).catch((error) => console.error("[costkey] Findings refresh worker error:", error));
          void refreshPriceCatalogIfChanged(pool).catch((error) => console.error("[costkey] Price catalog refresh error:", error));
        }, 5 * 60 * 1000);
        // Summaries read the rollup for settled days, so keep it current:
        // a run with nothing changed is a few small reads per project.
        let reconciling = false;
        const dailyAccounting = setInterval(() => {
          if (reconciling) return;
          reconciling = true;
          void reconcileDailyAccounting(pool)
            .catch((error) => console.error("[costkey] Daily accounting error:", error))
            .finally(() => { reconciling = false; });
        }, 5 * 60 * 1000);
        const dailyRetention = setInterval(() => {
          void reconcileDailyAccounting(pool)
            .then(() => runRetention(pool))
            .catch((error) => console.error("[costkey] Daily accounting/retention error:", error));
        }, 24 * 60 * 60 * 1000);
        const hourlyNotifications = setInterval(() => {
          void runWeeklyDigests(pool).catch((error) => console.error("[costkey] Notification digest error:", error));
        }, 60 * 60 * 1000);
        periodic.unref();
        dailyAccounting.unref();
        dailyRetention.unref();
        hourlyNotifications.unref();
        schedulerHandles.push(periodic, dailyAccounting, dailyRetention, hourlyNotifications);
        schedulerHandles.push(startQualityCheckWorker(pool));
        if (ingestQueue) ingestWorker = startIngestWorker(pool);
        schedulerHandles.push(startEmptyRunSweeper(pool));
        // Generate findings even when nobody opens the console. Ingest also
        // schedules a one-second project-local refresh; this startup pass
        // covers existing activity and the interval handles quiet projects.
        void refreshAllFindings(pool).catch((error) => console.error("[costkey] Initial findings refresh error:", error));
        void reconcileDailyAccounting(pool).catch((error) => console.error("[costkey] Initial daily accounting error:", error));
      }
      initialized = true;
      console.log("[costkey] Ready");
    })();
    try {
      await initialization;
    } catch (error) {
      initializationError = error;
      initialization = null;
      throw error;
    }
  };

  const stopSchedulers = () => {
    for (const handle of schedulerHandles.splice(0)) clearInterval(handle);
    ingestWorker?.stop();
    ingestWorker = null;
  };

  if (options.initialize) void initialize().catch((error) => console.error("[costkey] Init error:", error));

  // Under a base path ("/costkey") every route above is served beneath it, so
  // a load balancer can forward the sub-path unchanged. Health checks also
  // answer at the root for hosting platforms; the root itself points at the
  // console.
  let served: Express = app;
  if (base) {
    served = express();
    served.get(["/health", "/ready"], health);
    served.use(base, app);
    served.get("/", (_req, res) => res.redirect(`${base}/`));
    console.log("[costkey] Serving under", base);
  }

  // The returned value is both a normal Express app (for supertest/HTTP
  // harnesses) and a runtime handle exposing explicit initialization/timer
  // controls. Existing callers can use either `createApp()` or `.app`.
  const handle = served as Express & AppRuntime;
  handle.app = served;
  handle.pool = pool;
  handle.initialize = initialize;
  handle.stopSchedulers = stopSchedulers;
  return handle;
}

export async function startServer(options: AppOptions = {}): Promise<{ server: ReturnType<Express["listen"]>; runtime: AppRuntime }> {
  const runtime = createApp({ ...options, initialize: false });
  const port = Number.parseInt(process.env["PORT"] ?? "4100", 10);
  const host = options.host ?? process.env["COSTKEY_BIND_HOST"]
    ?? (process.env["NODE_ENV"] === "test" ? "127.0.0.1" : "0.0.0.0");
  const server = runtime.app.listen(port, host, () => {
    console.log(`[costkey] Listening on ${host}:${port}`);
    // During a rollout the old revision keeps writing while this one migrates, and
    // Postgres can pick the migration as a deadlock victim. Startup is safe to re-run,
    // so try again instead of shutting down.
    const start = (attempt: number): void => {
      // Each retry lets schema changes wait longer for their table locks.
      setMigrationLockTimeout(Math.min(3_000 * 2 ** attempt, 60_000));
      void runtime.initialize().catch((error) => {
        const code = (error as { code?: unknown } | null)?.code;
        // A lock conflict ends when the other work does: keep trying rather
        // than shutting down, and /ready answers 503 until startup is done.
        if (code === "40P01" || code === "55P03") {
          console.warn(`[costkey] Init hit a lock conflict (${String(code)}), retry ${attempt + 1}`);
          setTimeout(() => start(attempt + 1), Math.min(1000 * 2 ** attempt, 30_000)).unref();
          return;
        }
        console.error("[costkey] Init error:", error);
        server.close(() => undefined);
      });
    };
    start(0);
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 65_000;
  return { server, runtime };
}

const isMainModule = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;
if (isMainModule) {
  void startServer();
}
