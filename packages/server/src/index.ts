import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getPool, initDatabase } from "./db.js";
import { createIngestRouter, loadCallGraphCache } from "./ingest.js";
import { createApiRouter } from "./api.js";
import { createAuthRouter, authMiddleware } from "./auth.js";
import { createTeamsRouter } from "./teams.js";
import { createAlertsRouter, checkAlerts } from "./alerts.js";
import { createBudgetsRouter, runBudgetChecks } from "./budgets.js";
import { rateLimit } from "./middleware.js";
import { initAnomalyTable, detectAnomalies } from "./anomaly.js";
import { seedIfEmpty } from "./seed.js";
import { backfillCosts } from "./pricing.js";
import { createSourcemapsRouter } from "./sourcemaps.js";
import { initSourceMaps } from "./sourcemap-resolver.js";

const PORT = parseInt(process.env["PORT"] ?? "4100", 10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardDist = path.resolve(__dirname, "../../dashboard/dist");
const hasDashboard = fs.existsSync(path.join(dashboardDist, "index.html"));

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use((_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  next();
});

// 1. Health — always responds immediately
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0" });
});

// 2. Dashboard static files — serve BEFORE auth middleware
if (hasDashboard) {
  app.use(express.static(dashboardDist));
  console.log("[costkey] Dashboard static files from", dashboardDist);
}

// 3. Start HTTP server immediately (healthcheck + dashboard work instantly)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[costkey] Listening on 0.0.0.0:${PORT}`);
  initApp().catch((err) => console.error("[costkey] Init error:", err));
});

// 4. Async: connect DB, mount API routes
async function initApp() {
  const pool = getPool();
  console.log("[costkey] DATABASE_URL:", process.env["DATABASE_URL"]?.replace(/:[^@]+@/, ":***@") ?? "not set");

  await initDatabase();
  console.log("[costkey] Database ready");

  // Load call graph cache from DB
  await loadCallGraphCache(pool);

  // SPA routes — serve index.html for client-side routes BEFORE auth middleware
  // so /signup, /login, /onboarding don't get blocked
  if (hasDashboard) {
    const spaRoutes = ["/login", "/signup", "/onboarding", "/settings", "/invite/:token"];
    for (const route of spaRoutes) {
      app.get(route, (_req, res) => {
        res.sendFile(path.join(dashboardDist, "index.html"));
      });
    }
  }

  app.use(authMiddleware());

  app.use("/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
  app.use("/auth/signup", rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }));
  app.use("/api/v1/events", rateLimit({
    windowMs: 60 * 1000, max: 1000,
    keyFn: (req) => req.headers.authorization?.slice(7) ?? req.ip ?? "unknown",
  }));

  await seedIfEmpty(pool);

  app.use(createAuthRouter());
  app.use(createIngestRouter(pool));
  app.use(createTeamsRouter(pool));
  app.use(createAlertsRouter(pool));
  app.use(createBudgetsRouter(pool));
  app.use(createSourcemapsRouter(pool));
  app.use(createApiRouter(pool));

  await initSourceMaps();
  await backfillCosts(pool);
  await initAnomalyTable(pool);
  setInterval(() => {
    void checkAlerts(pool);
    void detectAnomalies(pool);
    void runBudgetChecks(pool);
  }, 5 * 60 * 1000);

  // Data retention: delete old events periodically
  const retentionDays = parseInt(process.env["COSTKEY_RETENTION_DAYS"] ?? "90", 10);
  const cleanupOldEvents = async () => {
    try {
      const result = await pool.query(
        `DELETE FROM events WHERE timestamp < NOW() - INTERVAL '1 day' * $1`,
        [retentionDays],
      );
      const deleted = result.rowCount ?? 0;
      if (deleted > 0) {
        console.log(`[costkey] Retention cleanup: deleted ${deleted} events older than ${retentionDays} days`);
      }
    } catch (err) {
      console.error("[costkey] Retention cleanup error:", err);
    }
  };
  void cleanupOldEvents();
  setInterval(() => void cleanupOldEvents(), 24 * 60 * 60 * 1000);

  // SPA fallback — LAST route, after all API routes
  if (hasDashboard) {
    app.get("/{*path}", (_req, res) => {
      res.sendFile(path.join(dashboardDist, "index.html"));
    });
  }

  console.log("[costkey] Ready");
}

