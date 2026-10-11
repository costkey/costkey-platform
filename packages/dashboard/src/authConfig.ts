import { useEffect, useState } from "react";
import { appUrl } from "./basePath";

/**
 * How this server signs people in, from GET /auth/config. In "iap" and
 * "oidc" modes the console shows no password forms; the server rejects
 * password routes anyway.
 */
export type AuthMode = "password" | "iap" | "oidc";
export type IapStatus = "signed_in" | "missing_assertion" | "invalid_assertion" | "access_removed" | "not_configured" | "error";

export interface AuthConfig {
  mode: AuthMode;
  password: boolean;
  github: boolean;
  configured: boolean;
  oidc?: { name: string; startPath: string };
  iap?: { logoutUrl: string; status: IapStatus };
}

/** What an older server without /auth/config does. */
export const PASSWORD_CONFIG: AuthConfig = { mode: "password", password: true, github: true, configured: true };

export { appUrl };

let cached: AuthConfig | null = null;
let inflight: Promise<AuthConfig> | null = null;

export async function fetchAuthConfig(options: { fresh?: boolean } = {}): Promise<AuthConfig> {
  if (cached && !options.fresh) return cached;
  if (inflight && !options.fresh) return inflight;
  inflight = (async () => {
    try {
      const response = await fetch(appUrl("/auth/config"), { credentials: "include", cache: "no-store" });
      if (!response.ok) return PASSWORD_CONFIG;
      const body = await response.json() as Partial<AuthConfig>;
      if (body.mode !== "password" && body.mode !== "iap" && body.mode !== "oidc") return PASSWORD_CONFIG;
      return { ...PASSWORD_CONFIG, ...body } as AuthConfig;
    } catch {
      return PASSWORD_CONFIG;
    }
  })();
  try {
    cached = await inflight;
    return cached;
  } finally {
    inflight = null;
  }
}

/** The sign-in config, or null while it loads. */
export function useAuthConfig(): AuthConfig | null {
  const [config, setConfig] = useState<AuthConfig | null>(cached);
  useEffect(() => {
    let alive = true;
    void fetchAuthConfig().then((value) => { if (alive) setConfig(value); });
    return () => { alive = false; };
  }, []);
  return config;
}

/** Seed the cache: tests, and anything that already fetched the config. */
export function primeAuthConfig(config: AuthConfig | null): void {
  cached = config;
}

/** Where to send an already signed-in visitor of the sign-in page. */
export function signedInDestination(params: URLSearchParams): string {
  if (params.get("cli") === "1") return "/cli-auth";
  return safeReturnTo(params.get("returnTo")) ?? "/";
}

/** The OIDC start link, carrying where to land afterwards. */
export function oidcStartHref(config: AuthConfig, params: URLSearchParams): string {
  const query = new URLSearchParams();
  const destination = signedInDestination(params);
  if (destination !== "/") query.set("returnTo", destination);
  const path = config.oidc?.startPath ?? "/auth/oidc/start";
  return appUrl(query.toString() ? `${path}?${query}` : path);
}

const ERRORS: Record<string, string> = {
  oidc_domain: "That account’s email domain can’t sign in to this workspace.",
  oidc_email_unverified: "Your provider hasn’t verified that email address.",
  oidc_no_email: "Your provider didn’t share an email address.",
  oidc_state: "That sign-in link expired. Try again.",
  oidc_denied: "Sign-in was cancelled.",
  oidc_unavailable: "The sign-in provider couldn’t be reached. Try again shortly.",
  oidc_not_configured: "Single sign-on isn’t fully configured. Ask your administrator.",
  oidc_failed: "Couldn’t sign you in. Try again.",
  access_removed: "Your access to this workspace was removed. Ask an owner or admin to invite you again.",
};

export function ssoErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return ERRORS[code] ?? null;
}

export function iapStatusMessage(status: IapStatus | undefined): { title: string; body: string } {
  switch (status) {
    case "not_configured":
      return { title: "Sign-in isn’t configured", body: "This server expects Identity-Aware Proxy, but COSTKEY_IAP_AUDIENCE is missing. Ask your administrator." };
    case "invalid_assertion":
      return { title: "Couldn’t verify your identity", body: "The Identity-Aware Proxy header on this request didn’t verify. Reload the page. If it keeps happening, ask your administrator to check COSTKEY_IAP_AUDIENCE." };
    case "access_removed":
      return { title: "Access removed", body: "Your access to this workspace was removed. Ask an owner or admin to invite you again." };
    case "error":
      return { title: "Couldn’t sign you in", body: "Something went wrong on the server. Reload the page to try again." };
    case "signed_in":
      return { title: "Signing you in", body: "One moment." };
    default:
      return { title: "Open CostKey through your sign-in", body: "This console uses your organization’s Google sign-in (Identity-Aware Proxy). This request didn’t come through it. Open CostKey from its usual address." };
  }
}

function safeReturnTo(raw: string | null): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  try {
    const resolved = new URL(raw, "https://costkey.invalid");
    if (resolved.origin !== "https://costkey.invalid") return null;
    if (/^\/(login|signup|auth)(\/|$)/.test(resolved.pathname)) return null;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return null;
  }
}
