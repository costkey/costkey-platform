import express from "express";
import cors from "cors";
import { createDatabase } from "./db.js";
import { createIngestRouter } from "./ingest.js";
import { createApiRouter } from "./api.js";
import { seedIfEmpty } from "./seed.js";

const PORT = parseInt(process.env["PORT"] ?? "4100", 10);

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const db = createDatabase();

// Seed demo data for development
seedIfEmpty(db);

// Mount routes
app.use(createIngestRouter(db));
app.use(createApiRouter(db));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "0.0.1" });
});

app.listen(PORT, () => {
  console.log(`[costkey] Server running on http://localhost:${PORT}`);
  console.log(`[costkey] Dashboard: http://localhost:5173`);
});
