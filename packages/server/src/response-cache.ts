/**
 * A short-lived cache for the console's heavy summary endpoints (Overview,
 * Costs, the board, forecast, spend series, agents, workflows, users). Each builds the
 * window's charges or runs, and opening the Overview asks for six of them at
 * once; on a small database they queue behind each other.
 *
 * A result is served at once for up to MAX_AGE_MS. Past FRESH_MS it is
 * refreshed in the background by asking this server again with the same
 * request, so the next load gets current numbers without waiting. A cold
 * summary takes seconds to build, so coming back to the console within the
 * hour shows the last numbers at once instead of an empty page. Identical
 * requests in flight share one computation. Any change to a project (a price,
 * budget or mapping) drops that project's entries.
 *
 * Mounted after authentication and project access, and keyed by user, so it
 * only ever answers a request its user may make.
 */
import type { NextFunction, Request, Response } from "express";

const FRESH_MS = 30_000;
const MAX_AGE_MS = 60 * 60_000;
const MAX_ENTRIES = 500;
/** Marks the server's own background refresh, which must not be answered from the cache. */
const REFRESH_HEADER = "x-costkey-cache-refresh";

interface Entry { projectId: string; at: number; status: number; body: unknown }

const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<void>>();

function userKey(req: Request): string {
  const user = (req as unknown as { user?: { id?: string; role?: string } }).user;
  return `${user?.id ?? "?"}:${user?.role ?? "?"}`;
}

/** The request as a cache key, with a "to" near now treated as now (the console sends the current time). */
function cacheKey(req: Request): string {
  const url = new URL(req.originalUrl, "http://local");
  const to = url.searchParams.get("to");
  if (to && Math.abs(Date.parse(to) - Date.now()) < 5 * 60_000) url.searchParams.set("to", "now");
  url.searchParams.sort();
  return `${userKey(req)}|${url.pathname}?${url.searchParams.toString()}`;
}

function remember(key: string, entry: Entry): void {
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

/** Ask this server for the same thing again, with the caller's credentials, to refresh an entry. */
function refreshInBackground(req: Request, key: string): void {
  if (pending.has(key)) return;
  const headers: Record<string, string> = { [REFRESH_HEADER]: "1" };
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string" && !["host", "content-length", "connection"].includes(name)) headers[name] = value;
  }
  const port = req.socket.localPort ?? Number(process.env["PORT"] ?? 4100);
  const job = fetch(`http://127.0.0.1:${port}${req.originalUrl}`, { headers, signal: AbortSignal.timeout(60_000) })
    .then(() => undefined, () => undefined)
    .finally(() => pending.delete(key));
  pending.set(key, job);
}

export function cachedSummaries() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET") { next(); return; }
    const projectId = String(req.params["projectId"] ?? req.params["id"] ?? "");
    const key = cacheKey(req);
    const refreshing = req.headers[REFRESH_HEADER] === "1";
    const hit = entries.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (!refreshing && hit && age < MAX_AGE_MS) {
      res.setHeader("X-CostKey-Cache", age < FRESH_MS ? "fresh" : "stale");
      res.status(hit.status).json(hit.body);
      if (age >= FRESH_MS) refreshInBackground(req, key);
      return;
    }
    // A miss: keep the response for the next request. Only successes are kept.
    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 400) remember(key, { projectId, at: Date.now(), status: res.statusCode, body });
      return send(body);
    };
    next();
  };
}

const invalidationListeners: Array<(projectId?: string) => void> = [];

/** Other per-project caches (the SDK runtime config) drop their entries with the summaries. */
export function onInvalidateSummaries(listener: (projectId?: string) => void): void {
  invalidationListeners.push(listener);
}

/** Drop a project's cached summaries after it changes; no project id drops everything (a price list change). */
export function invalidateSummaries(projectId?: string): void {
  for (const [key, entry] of entries) if (!projectId || entry.projectId === projectId) entries.delete(key);
  for (const listener of invalidationListeners) listener(projectId);
}

/**
 * A change through the console's API drops the summaries it could affect: a
 * project's settings, prices, budgets or mappings drop that project's; the
 * price list or workspace settings drop everything. Ingest, admission checks
 * and MCP calls change nothing cached (new calls refresh on their own).
 */
export function invalidateOnChange() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      const path = new URL(req.originalUrl, "http://local").pathname;
      const project = /\/api\/v1\/projects\/([^/]+)\//.exec(path);
      const drop = () => {
        if (project) invalidateSummaries(decodeURIComponent(project[1]!));
        else if (/\/api\/v1\/(pricing|workspace|settings|org)\b/.test(path)) invalidateSummaries();
      };
      drop();
      // Again once the change is saved: anything computed while it was being made is out of date too.
      res.once("finish", drop);
    }
    next();
  };
}
