import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { ensureQualityCheckSchema, getPool, initDatabase } from "./db.js";
import { createIngestRouter, loadCallGraphCache } from "./ingest.js";
import { createAuthRouter, authMiddleware } from "./auth.js";
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
import { createRetentionRouter, runRetention } from "./retention.js";
import { createSavedViewsRouter } from "./saved-views.js";
import { createNotificationsRouter, runWeeklyDigests } from "./notifications.js";
import { createSubscriptionRouter } from "./subscription.js";
import { refreshAllFindings } from "./findings.js";
import { reconcileDailyCostAggregates } from "./accounting.js";
import { startQualityCheckWorker } from "./quality-checks/worker.js";
import { seedDemoQualityChecks } from "./quality-checks/seed.js";
import { basePath } from "./public-url.js";

// Set by the image build from the release tag; "dev" when run from source.
const SERVER_VERSION = process.env["COSTKEY_VERSION"] || "dev";

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

function localDateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

function dateKey(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

/** Publish every missing completed local day before retention is allowed to purge detail. */
async function reconcileDailyAccounting(pool: pg.Pool): Promise<void> {
  const projects = await pool.query(
    `SELECT p.id, COALESCE(ws.timezone, 'UTC') AS timezone,
            COALESCE(ps.aggregate_retention_days, 395) AS aggregate_retention_days,
            cp.through_day::text AS through_day
     FROM projects p
     LEFT JOIN workspace_settings ws ON ws.org_id = p.org_id
     LEFT JOIN project_settings ps ON ps.project_id = p.id
     LEFT JOIN daily_cost_aggregate_checkpoints cp ON cp.project_id = p.id
     ORDER BY p.id`,
  );
  const now = new Date();
  for (const row of projects.rows ?? []) {
    const timezone = String(row.timezone ?? "UTC");
    let local: { year: number; month: number; day: number };
    try { local = localDateParts(now, timezone); }
    catch { local = localDateParts(now, "UTC"); }
    const yesterday = new Date(Date.UTC(local.year, local.month - 1, local.day - 1));
    const checkpoint = row.through_day ? new Date(`${String(row.through_day).slice(0, 10)}T00:00:00Z`) : null;
    const retentionDays = Math.min(Math.max(Number(row.aggregate_retention_days ?? 395), 30), 395);
    const retentionStart = new Date(yesterday.getTime() - (retentionDays - 1) * 86_400_000);
    const start = checkpoint && !Number.isNaN(checkpoint.getTime())
      ? new Date(Math.max(checkpoint.getTime() + 86_400_000, retentionStart.getTime()))
      : retentionStart;
    for (let cursor = start; cursor <= yesterday; cursor = new Date(cursor.getTime() + 86_400_000)) {
      await reconcileDailyCostAggregates(pool, String(row.id), dateKey(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate()));
    }
  }
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
  const app = express();
  const schedulerHandles: NodeJS.Timeout[] = [];
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
      res.status(503).json({ status: initializationError ? "error" : "starting", version: SERVER_VERSION });
      return;
    }
    res.json({ status: "ok", version: SERVER_VERSION });
  };
  app.get(["/health", "/ready"], health);
  addSpaRoutes(app, options.includeDashboard !== false, base);

  // Authentication is non-blocking for SDK and public routes. API routers
  // enforce it where a user identity is required.
  app.use(authMiddleware(pool));

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
  app.use(createSdkAdmissionRouter(pool));
  app.use(createSdkBudgetCompatibilityRouter(pool));
  app.use(createAuthRouter(pool));
  app.use(createIngestRuntimeConfigRouter(pool));
  app.use(createIngestRouter(pool));
  // Public, token-scoped routes go before routers that require auth globally.
  app.use(createInvitePreviewRouter(pool));
  app.use(createSubscriptionRouter(pool));
  app.use(createPlatformRouter(pool));
  app.use(createPrivacyRouter(pool));
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
      // A supplied pool belongs to a harness and owns its own schema setup;
      // the production pool uses the legacy initializer before platform DDL.
      if (!options.pool) await initDatabase();
      await ensurePlatformSchema(pool);
      await ensurePolicySchema(pool);
      await ensureQualityCheckSchema(pool);
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
        const dailyRetention = setInterval(() => {
          void reconcileDailyAccounting(pool)
            .then(() => runRetention(pool))
            .catch((error) => console.error("[costkey] Daily accounting/retention error:", error));
        }, 24 * 60 * 60 * 1000);
        const hourlyNotifications = setInterval(() => {
          void runWeeklyDigests(pool).catch((error) => console.error("[costkey] Notification digest error:", error));
        }, 60 * 60 * 1000);
        periodic.unref();
        dailyRetention.unref();
        hourlyNotifications.unref();
        schedulerHandles.push(periodic, dailyRetention, hourlyNotifications);
        schedulerHandles.push(startQualityCheckWorker(pool));
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
    void runtime.initialize().catch((error) => {
      console.error("[costkey] Init error:", error);
      server.close(() => undefined);
    });
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
