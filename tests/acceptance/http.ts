import assert from "node:assert/strict";

export interface HttpResult<T = unknown> {
  status: number;
  headers: Headers;
  body: T | string | null;
  rawBody: string;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
  timeoutMs?: number;
  redirect?: RequestRedirect;
}

/**
 * Tiny fetch client for the acceptance runner. It intentionally has a small
 * cookie jar because the local server authenticates dashboard requests with
 * an httpOnly `ck_token` cookie. It never prints cookies or authorization
 * headers.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly cookies = new Map<string, string>();
  private bearerToken: string | null = null;

  constructor(baseUrl: string) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" || !isLoopback(parsed.hostname)) {
      throw new Error("HttpClient only accepts an explicit loopback HTTP base URL");
    }
    this.baseUrl = parsed.toString().replace(/\/$/, "");
    this.baseOrigin = parsed.origin;
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
    const url = path.startsWith("http://") || path.startsWith("https://")
      ? path
      : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const parsedUrl = new URL(url);
    if (parsedUrl.origin !== this.baseOrigin || !isLoopback(parsedUrl.hostname)) {
      throw new Error("HttpClient refused a cross-origin or non-loopback request");
    }

    const headers = new Headers(options.headers);
    if (this.bearerToken && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${this.bearerToken}`);
    }
    if (this.cookies.size > 0 && !headers.has("cookie")) {
      headers.set(
        "cookie",
        Array.from(this.cookies.entries(), ([name, value]) => `${name}=${value}`).join("; "),
      );
    }

    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (typeof options.body === "string" || options.body instanceof Uint8Array) {
        body = options.body as BodyInit;
      } else {
        body = JSON.stringify(options.body);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(100, options.timeoutMs ?? 10_000),
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        body,
        signal: controller.signal,
        redirect: options.redirect ?? "manual",
      });
    } finally {
      clearTimeout(timeout);
    }

    this.captureCookies(response.headers);
    const rawBody = await response.text();
    let parsed: T | string | null = rawBody;
    const contentType = response.headers.get("content-type") ?? "";
    if (rawBody.length === 0) {
      parsed = null;
    } else if (contentType.includes("json")) {
      try {
        parsed = JSON.parse(rawBody) as T;
      } catch {
        parsed = rawBody;
      }
    }

    return { status: response.status, headers: response.headers, body: parsed, rawBody };
  }

  async json<T = unknown>(path: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
    const result = await this.request<T>(path, options);
    assert.match(
      result.headers.get("content-type") ?? "",
      /json/i,
      `Expected JSON response for ${options.method ?? "GET"} ${path}, received ${result.status}`,
    );
    return result;
  }

  clearCookies(): void {
    this.cookies.clear();
    this.bearerToken = null;
  }

  setBearerToken(token: string): void {
    if (!token.trim()) throw new Error("HttpClient cannot install an empty bearer token");
    this.bearerToken = token;
  }

  private captureCookies(headers: Headers): void {
    // Node's fetch implementation exposes getSetCookie() where available.
    // The fallback handles the single-cookie responses used by CostKey.
    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const values = typeof getSetCookie === "function"
      ? getSetCookie.call(headers)
      : headers.get("set-cookie")
        ? [headers.get("set-cookie") as string]
        : [];

    for (const value of values) {
      const first = value.split(";", 1)[0];
      const separator = first.indexOf("=");
      if (separator < 1) continue;
      const name = first.slice(0, separator).trim();
      const cookieValue = first.slice(separator + 1).trim();
      if (!cookieValue) this.cookies.delete(name);
      else this.cookies.set(name, cookieValue);
    }
  }
}

export function jsonBody<T>(result: HttpResult<unknown>, label: string): T {
  assert.notEqual(result.body, null, `${label}: response body is empty`);
  assert.equal(typeof result.body, "object", `${label}: expected JSON object`);
  return result.body as T;
}

export function expectStatus(
  result: HttpResult<unknown>,
  expected: number | readonly number[],
  label: string,
): void {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(
    statuses.includes(result.status),
    `${label}: expected HTTP ${statuses.join(" or ")}, received ${result.status}; body=${safeBody(result.body)}`,
  );
}

export function safeBody(body: unknown): string {
  if (body === null || body === undefined) return "<empty>";
  if (typeof body === "string") return redactText(body).slice(0, 240);
  try {
    if (typeof body === "object") {
      const keys = Object.keys(body as Record<string, unknown>).slice(0, 20);
      return `<json keys: ${keys.join(", ")}>`;
    }
    return redactText(String(body)).slice(0, 240);
  } catch {
    return "<unserializable>";
  }
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/((?:password|secret|token|dsn|authorization|api[_-]?key)\s*[:=]\s*)[^,;\s}"']+/gi, "$1<redacted>");
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}
