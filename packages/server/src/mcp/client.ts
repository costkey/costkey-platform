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

/**
 * This same server, over loopback on the port the request arrived on. Not the
 * request's local address: behind Cloud Run and other proxies that is the
 * sandbox's interface, which the container can't connect back to.
 */
export function loopbackOrigin(req: Request): string {
  const port = req.socket.localPort ?? Number(process.env["PORT"] ?? 4100);
  return `http://127.0.0.1:${port}`;
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
