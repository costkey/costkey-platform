import express from "express";
import type { Express } from "express";
import { rateLimit } from "./middleware.js";

export function configureRequestParsing(app: Express): void {
  // Large multimodal batches are expensive to parse, so enforce an IP-based
  // ceiling before reading the body. Authentication-specific limiting runs
  // later, once the app's asynchronous initialization has completed.
  app.use("/api/v1/events", rateLimit({ windowMs: 60 * 1000, max: 60 }));
  app.use("/api/v1/events", express.json({ limit: "12mb" }));
  app.use(express.json({ limit: "5mb" }));
}
