import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, initDatabase } from "./db.js";
import { createIngestRouter } from "./ingest.js";
import { createApiRouter } from "./api.js";
import { createAuthRouter, authMiddleware } from "./auth.js";
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

  // Auth middleware
  app.use(authMiddleware());

  // Seed demo data
  await seedIfEmpty(pool);

  // Routes
  app.use(createAuthRouter());
  app.use(createIngestRouter(pool));
  app.use(createApiRouter(pool));

  // Health
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });

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
