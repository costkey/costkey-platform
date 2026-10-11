/**
 * Where people and SDKs reach this server: PUBLIC_URL; else the address a
 * hosting platform gives the service (Render, Railway, Fly.io); else this
 * machine on its own port.
 */
function platformUrl(): string | undefined {
  const env = process.env;
  if (env["RENDER_EXTERNAL_URL"]) return env["RENDER_EXTERNAL_URL"];
  if (env["RAILWAY_PUBLIC_DOMAIN"]) return `https://${env["RAILWAY_PUBLIC_DOMAIN"]}`;
  if (env["FLY_APP_NAME"]) return `https://${env["FLY_APP_NAME"]}.fly.dev`;
  return undefined;
}

function parse(value: string | undefined): URL | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function publicUrl(): URL {
  return parse(process.env["PUBLIC_URL"])
    ?? parse(platformUrl())
    ?? new URL(`http://localhost:${process.env["PORT"] || 4100}`);
}

/** The origin with no trailing slash. Links into the app use publicAppUrl. */
export function publicOrigin(): string {
  return publicUrl().origin;
}

function normalizeBasePath(raw: string): string {
  const path = `/${raw.trim()}`.replace(/\/{2,}/g, "/");
  try {
    // The URL parser resolves dot segments and percent-encodes characters
    // that are unsafe in a path, so the result is safe to put in links.
    return new URL(path, "http://base.invalid").pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * The URL path the app is served under, with no trailing slash: "/costkey"
 * for PUBLIC_URL=https://example.com/costkey, "" at the root. A load balancer
 * that forwards a sub-path unchanged needs every route under this prefix.
 * COSTKEY_BASE_PATH overrides the path of PUBLIC_URL.
 */
export function basePath(): string {
  const override = process.env["COSTKEY_BASE_PATH"];
  if (override?.trim()) return normalizeBasePath(override);
  return normalizeBasePath(publicUrl().pathname);
}

/** An app path ("/login") under the base path ("/costkey/login"). */
export function appPath(path: string): string {
  return `${basePath()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The origin and base path with no trailing slash, for building links. */
export function publicAppUrl(): string {
  return `${publicOrigin()}${basePath()}`;
}

/** Cookies are scoped to the base path so apps sharing a host keep theirs apart. */
export function cookiePath(): string {
  return basePath() || "/";
}

/** A project's DSN, pointing SDKs at this server. */
export function projectDsn(authKey: string, projectId: string): string {
  const url = publicUrl();
  return `${url.protocol}//${authKey}@${url.host}${basePath()}/${projectId}`;
}

/**
 * Session cookies are Secure when the console is served over HTTPS. A
 * self-hosted install on plain http (a LAN address, say) still signs in.
 * COSTKEY_COOKIE_SECURE=true|false overrides.
 */
export function secureCookies(): boolean {
  const override = process.env["COSTKEY_COOKIE_SECURE"];
  if (override === "true") return true;
  if (override === "false") return false;
  return publicUrl().protocol === "https:";
}
