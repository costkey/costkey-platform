import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, initDatabase } from "./db.js";
import { createIngestRouter } from "./ingest.js";
import { createApiRouter } from "./api.js";
import { createAuthRouter, authMiddleware } from "./auth.js";
import { createTeamsRouter } from "./teams.js";
import { createAlertsRouter, checkAlerts } from "./alerts.js";
import { rateLimit } from "./middleware.js";
import { seedIfEmpty } from "./seed.js";

const PORT = parseInt(process.env["PORT"] ?? "4100", 10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "5mb" }));
  app.use(cookieParser());

  // Initialize Postgres + schema
  const pool = getPool();
  await initDatabase();

  // Auth middleware (sets req.user from JWT)
  app.use(authMiddleware());

  // Rate limiting
  app.use("/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));      // 20 login attempts per 15 min
  app.use("/auth/signup", rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }));      // 10 signups per hour
  app.use("/api/v1/events", rateLimit({                                             // 1000 event batches per min per key
    windowMs: 60 * 1000,
    max: 1000,
    keyFn: (req) => req.headers.authorization?.slice(7) ?? req.ip ?? "unknown",
  }));

  // Seed demo data
  await seedIfEmpty(pool);

  // Routes
  app.use(createAuthRouter());            // /auth/*
  app.use(createIngestRouter(pool));      // /api/v1/events (SDK ingest, DSN auth)
  app.use(createTeamsRouter(pool));       // /api/v1/team/*
  app.use(createAlertsRouter(pool));      // /api/v1/alerts/*
  app.use(createApiRouter(pool));         // /api/v1/projects/* (org-scoped)

  // Health
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });

  // Alert check every 5 minutes
  setInterval(() => { void checkAlerts(pool); }, 5 * 60 * 1000);

  // Serve dashboard in production
  const dashboardDist = path.resolve(__dirname, "../../dashboard/dist");
  app.use(express.static(dashboardDist));
  app.get("/{*path}", (_req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });

  app.listen(PORT, () => {
    console.log(`[costkey] Server running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[costkey] Fatal:", err);
  process.exit(1);
});
