import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./db.js";
import { createIngestRouter } from "./ingest.js";
import { createApiRouter } from "./api.js";
import { createAuthRouter, authMiddleware } from "./auth.js";
import { seedIfEmpty } from "./seed.js";

const PORT = parseInt(process.env["PORT"] ?? "4100", 10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

const db = createDatabase();

// Auth middleware — sets req.user from JWT cookie/header
app.use(authMiddleware(db));

// Seed demo data for development
seedIfEmpty(db);

// Mount API routes
app.use(createAuthRouter(db));    // /auth/signup, /auth/login, /auth/me
app.use(createIngestRouter(db));  // /api/v1/events (SDK ingest)
app.use(createApiRouter(db));     // /api/v1/projects/... (dashboard API)

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0" });
});

// Serve dashboard static files in production
// The dashboard builds to packages/dashboard/dist/
const dashboardDist = path.resolve(__dirname, "../../dashboard/dist");
app.use(express.static(dashboardDist));
// SPA fallback — serve index.html for any non-API route
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(dashboardDist, "index.html"));
});

app.listen(PORT, () => {
  console.log(`[costkey] Server running on http://localhost:${PORT}`);
});
