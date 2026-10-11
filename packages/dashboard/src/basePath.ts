declare global {
  interface Window {
    /** The URL path the console is served under, set by the server in index.html. */
    __COSTKEY_BASE__?: string;
  }
}

function normalize(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * The path the console is served under, with no trailing slash: "/costkey"
 * behind a load balancer that forwards a sub-path, "" at the root and in the
 * Vite dev server. The same build works under any base path because the
 * server injects it into index.html.
 */
export const BASE_PATH = normalize(typeof window === "undefined" ? undefined : window.__COSTKEY_BASE__);

/**
 * An absolute URL path on this server ("/api/v1/...", "/auth/...",
 * "/providers/x.svg") under the base path. Every absolute URL the console
 * fetches, links to or loads goes through this.
 */
export function appUrl(path: string): string {
  return `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}

/** A browser pathname with the base path removed, as react-router sees it. */
export function routerPath(pathname: string): string {
  if (!BASE_PATH) return pathname;
  if (pathname === BASE_PATH) return "/";
  return pathname.startsWith(`${BASE_PATH}/`) ? pathname.slice(BASE_PATH.length) : pathname;
}

/** The current location as a react-router path, for return links. */
export function currentRouterPath(): string {
  return `${routerPath(window.location.pathname)}${window.location.search}`;
}

/** A project's DSN, pointing SDKs at the host and base path serving this console. */
export function projectDsn(authKey: string, projectId: string): string {
  return `${window.location.protocol}//${authKey}@${window.location.host}${BASE_PATH}/${projectId}`;
}
