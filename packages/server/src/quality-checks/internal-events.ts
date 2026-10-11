import type { Router } from "express";
import type pg from "pg";
import { createIngestRouter } from "../ingest.js";

/**
 * Record server-originated provider calls (the judges' own usage) through the
 * same ingest pipeline SDK telemetry uses, in process: identical privacy,
 * pricing, accounting and findings handling, with no network hop and no SDK.
 */

const routers = new WeakMap<pg.Pool, Router>();

function ingestRouter(pool: pg.Pool): Router {
  let router = routers.get(pool);
  if (!router) {
    router = createIngestRouter(pool);
    routers.set(pool, router);
  }
  return router;
}

export interface InternalIngestResult {
  status: number;
  body: Record<string, unknown>;
}

export async function recordInternalEvents(pool: pg.Pool, projectId: string, events: Array<Record<string, unknown>>): Promise<InternalIngestResult> {
  const project = await pool.query("SELECT auth_key FROM projects WHERE id = $1", [projectId]);
  const authKey = project.rows[0]?.auth_key as string | undefined;
  if (!authKey) return { status: 404, body: { error: "Project not found" } };

  return new Promise<InternalIngestResult>((resolve, reject) => {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    const req = {
      method: "POST",
      url: "/api/v1/events",
      originalUrl: "/api/v1/events",
      path: "/api/v1/events",
      headers: { authorization: `Bearer ${authKey}`, "content-type": "application/json" },
      // A version of 0.6 or later: call timestamps are the start of the call.
      body: { sdkVersion: "costkey-server/1.0", events },
      query: {},
      params: {},
      get(name: string) { return (this.headers as Record<string, string>)[name.toLowerCase()]; },
    };
    const res = {
      statusCode,
      headersSent: false,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
      getHeader(name: string) { return headers[name.toLowerCase()]; },
      json(body: Record<string, unknown>) { this.headersSent = true; resolve({ status: statusCode, body }); return this; },
      send(body: unknown) { this.headersSent = true; resolve({ status: statusCode, body: { body } }); return this; },
      end() { this.headersSent = true; resolve({ status: statusCode, body: {} }); return this; },
    };
    const done = (error?: unknown) => {
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve({ status: 404, body: { error: "Ingest route not found" } });
    };
    (ingestRouter(pool) as unknown as (req: unknown, res: unknown, next: (error?: unknown) => void) => void)(req, res, done);
  });
}
