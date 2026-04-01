import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getPool, initDatabase } from "./db.js";
import { createIngestRouter } from "./ingest.js";
import { createApiRouter } from "./api.js";
import { createAuthRouter, authMiddleware } from "./auth.js";
import { createTeamsRouter } from "./teams.js";
import { createAlertsRouter, checkAlerts } from "./alerts.js";
import { rateLimit } from "./middleware.js";
import { initAnomalyTable, detectAnomalies } from "./anomaly.js";
import { seedIfEmpty } from "./seed.js";

const PORT = parseInt(process.env["PORT"] ?? "4100", 10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

// Health check — always works, even before DB is ready
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0" });
});

// Start HTTP server FIRST so healthcheck passes
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[costkey] Server listening on 0.0.0.0:${PORT}`);
  // Then initialize everything else
  initApp().catch((err) => {
    console.error("[costkey] Init error:", err);
  });
});

async function initApp() {
  const pool = getPool();

  console.log("[costkey] Connecting to Postgres...");
  console.log("[costkey] DATABASE_URL:", process.env["DATABASE_URL"]?.replace(/:[^@]+@/, ":***@") ?? "not set");

  await initDatabase();
  console.log("[costkey] Database ready");

  // Auth middleware
  app.use(authMiddleware());

  // Rate limiting
  app.use("/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
  app.use("/auth/signup", rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }));
  app.use("/api/v1/events", rateLimit({
    windowMs: 60 * 1000, max: 1000,
    keyFn: (req) => req.headers.authorization?.slice(7) ?? req.ip ?? "unknown",
  }));

  // Seed demo data
  await seedIfEmpty(pool);

  // Routes
  app.use(createAuthRouter());
  app.use(createIngestRouter(pool));
  app.use(createTeamsRouter(pool));
  app.use(createAlertsRouter(pool));
  app.use(createApiRouter(pool));

  // Anomaly detection
  await initAnomalyTable(pool);
  setInterval(() => {
    void checkAlerts(pool);
    void detectAnomalies(pool);
  }, 5 * 60 * 1000);

  // Serve dashboard
  const dashboardDist = path.resolve(__dirname, "../../dashboard/dist");
  if (fs.existsSync(path.join(dashboardDist, "index.html"))) {
    app.use(express.static(dashboardDist));
    app.get("/{*path}", (_req, res) => {
      res.sendFile(path.join(dashboardDist, "index.html"));
    });
    console.log("[costkey] Dashboard served from", dashboardDist);
  } else {
    console.log("[costkey] No dashboard build found, API-only mode");
  }

  console.log("[costkey] Ready");
}
