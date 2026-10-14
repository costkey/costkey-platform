/**
 * MCP tools read through this server's own REST routes, over loopback, with
 * the caller's token. Project access, the Viewer redaction and the project's
 * source-access switch are then applied exactly as they are for the console:
 * there is no second query path to keep in step.
 */
import type { Request } from "express";
import { basePath } from "../public-url.js";

export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface RestClient {
  get<T = Record<string, unknown>>(path: string, query?: Record<string, QueryValue>): Promise<T>;
}

/** The address this request arrived on, so the loopback call reaches this same server. */
export function loopbackOrigin(req: Request): string {
  const socket = req.socket;
  let host = socket.localAddress ?? "127.0.0.1";
  if (host.startsWith("::ffff:")) host = host.slice(7);
  if (host === "::" || host === "0.0.0.0") host = "127.0.0.1";
  if (host.includes(":")) host = `[${host}]`;
  return `http://${host}:${socket.localPort}`;
}

export function queryString(query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function createRestClient(origin: string, token: string, timeoutMs = 20_000): RestClient {
  const base = `${origin}${basePath()}`;
  return {
    async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
      const response = await fetch(`${base}${path}${queryString(query)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!response.ok) {
        const message = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Request failed (${response.status})`;
        throw new ApiError(response.status, message);
      }
      return body as T;
    },
  };
}
