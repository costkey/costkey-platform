import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { rateLimit } from "./middleware.js";

export function configureRequestParsing(app: Express): void {
  // Large multimodal batches are expensive to parse, so enforce an IP-based
  // ceiling before reading the body. Authentication-specific limiting runs
  // later, once the app's asynchronous initialization has completed.
  app.use("/api/v1/events", rateLimit({ windowMs: 60 * 1000, max: 60 }));
  app.use("/api/v1/events", express.json({ limit: "12mb" }));
  app.use(express.json({ limit: "5mb" }));
}

/**
 * Body-parser errors otherwise fall through to Express's HTML stack-trace
 * handler. In production that turns a client closing a large upload into a
 * noisy 400 log. Keep the signal, return JSON for intact connections, and let
 * ordinary application errors continue to the normal handler.
 */
export function requestParseErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const error = (err ?? {}) as { type?: string; code?: string; status?: number; received?: number; expected?: number };

  if (error.type === "request.aborted" || error.code === "ECONNABORTED") {
    const requestPath = req.path || req.originalUrl.split("?")[0];
    console.info(
      `[costkey] Client aborted request before body parsing: ${req.method} ${requestPath}`
      + ` (${error.received ?? 0}/${error.expected ?? "?"} bytes)`,
    );
    if (!res.headersSent && !req.destroyed) {
      res.status(499).json({ error: "Request aborted" });
    }
    return;
  }

  if (error.type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large" });
    return;
  }

  if (error.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON payload" });
    return;
  }

  next(err);
}
