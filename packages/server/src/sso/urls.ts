/**
 * Every redirect, cookie path and absolute URL the sign-in code builds goes
 * through these helpers.
 *
 * MERGE(base-path): public-url.ts is gaining basePath(), appPath(),
 * publicAppUrl() and cookiePath() with these exact semantics. When it has
 * them, replace this file's body with:
 *
 *   export { appPath, cookiePath, publicAppUrl } from "../public-url.js";
 */
import { publicUrl } from "../public-url.js";

function normalizeBasePath(raw: string): string {
  const path = `/${raw.trim()}`.replace(/\/{2,}/g, "/");
  try {
    return new URL(path, "http://base.invalid").pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** "/costkey" for PUBLIC_URL=https://example.com/costkey, "" at the root. */
function basePath(): string {
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
  return `${publicUrl().origin}${basePath()}`;
}

/** Cookies are scoped to the base path so apps sharing a host keep theirs apart. */
export function cookiePath(): string {
  return basePath() || "/";
}
