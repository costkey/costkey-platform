/**
 * How people sign in to the console. One place reads every sign-in setting.
 *
 *   COSTKEY_AUTH=password  email/password, plus GitHub when GITHUB_CLIENT_ID is set (default)
 *   COSTKEY_AUTH=iap       Google Cloud Identity-Aware Proxy in front of the console
 *   COSTKEY_AUTH=oidc      any OpenID Connect provider (Google Workspace, Okta, Entra ID)
 *
 * Settings are read from the environment on every call so tests can change
 * them; parsing is cheap. Problems are logged once per distinct message.
 */

export type AuthMode = "password" | "iap" | "oidc";
export type SsoRole = "admin" | "developer" | "viewer";

export interface IapSettings {
  /** Accepted `aud` values: /projects/<number>/(global|<region>)/backendServices/<id>. IAP puts no "regions/" segment in regional audiences. */
  audiences: string[];
}

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** Lower-case email domains; ["*"] allows any verified email. */
  allowedDomains: string[];
  displayName: string;
}

export interface AuthSettings {
  mode: AuthMode;
  /** Role for people who sign in with SSO and have no invite. Never owner. */
  defaultRole: SsoRole;
  iap: IapSettings | null;
  oidc: OidcSettings | null;
  /** Human readable problems. When non-empty in an SSO mode, nobody can sign in. */
  problems: string[];
}

const SSO_ROLES: readonly SsoRole[] = ["admin", "developer", "viewer"];

const AUDIENCE_PATTERN = /^\/projects\/\d+\/(global|[a-z]+-[a-z]+\d+)\/backendServices\/\d+$/;

const logged = new Set<string>();
function logOnce(message: string): void {
  if (logged.has(message)) return;
  logged.add(message);
  console.error(`[costkey] Sign-in configuration: ${message}`);
}

function list(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

/** Read COSTKEY_AUTH. An unknown value throws: guessing could re-enable passwords. */
export function readAuthMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const raw = (env["COSTKEY_AUTH"] ?? "").trim().toLowerCase();
  if (!raw || raw === "password") return "password";
  if (raw === "iap" || raw === "oidc") return raw;
  throw new Error(`COSTKEY_AUTH must be password, iap or oidc (got "${env["COSTKEY_AUTH"]}")`);
}

export function readAuthSettings(env: NodeJS.ProcessEnv = process.env): AuthSettings {
  const mode = readAuthMode(env);
  const problems: string[] = [];

  const rawRole = (env["COSTKEY_SSO_DEFAULT_ROLE"] ?? "").trim().toLowerCase();
  let defaultRole: SsoRole = "developer";
  if (rawRole) {
    if ((SSO_ROLES as readonly string[]).includes(rawRole)) defaultRole = rawRole as SsoRole;
    else {
      // Fail safe: the least privileged role, never a guess upwards.
      defaultRole = "viewer";
      if (mode !== "password") logOnce(`COSTKEY_SSO_DEFAULT_ROLE must be admin, developer or viewer (got "${rawRole}"). Using viewer.`);
    }
  }

  let iap: IapSettings | null = null;
  if (mode === "iap") {
    const audiences = list(env["COSTKEY_IAP_AUDIENCE"]);
    if (audiences.length === 0) {
      problems.push("COSTKEY_IAP_AUDIENCE is not set. Set it to /projects/<number>/<region>/backendServices/<id>, for example /projects/123/asia-south1/backendServices/456 (or /projects/<number>/global/backendServices/<id> for a global load balancer).");
    }
    for (const audience of audiences) {
      // A warning, not a failure: the token's aud is compared exactly anyway.
      if (!AUDIENCE_PATTERN.test(audience)) {
        logOnce(`COSTKEY_IAP_AUDIENCE value "${audience}" does not look like /projects/<number>/<region>/backendServices/<id> or /projects/<number>/global/backendServices/<id>. IAP puts no "regions/" segment in a regional audience. Use the project number, not the project ID.`);
      }
    }
    iap = { audiences };
  }

  let oidc: OidcSettings | null = null;
  if (mode === "oidc") {
    const issuer = (env["COSTKEY_OIDC_ISSUER"] ?? "").trim().replace(/\/+$/, "");
    const clientId = (env["COSTKEY_OIDC_CLIENT_ID"] ?? "").trim();
    const clientSecret = env["COSTKEY_OIDC_CLIENT_SECRET"] ?? "";
    const allowedDomains = list(env["COSTKEY_OIDC_ALLOWED_DOMAINS"]).map((domain) => domain.toLowerCase().replace(/^@/, ""));
    if (!issuer) problems.push("COSTKEY_OIDC_ISSUER is not set.");
    else {
      try {
        const url = new URL(issuer);
        const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
        if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
          problems.push("COSTKEY_OIDC_ISSUER must be an https URL.");
        }
      } catch {
        problems.push(`COSTKEY_OIDC_ISSUER is not a URL (got "${issuer}").`);
      }
    }
    if (!clientId) problems.push("COSTKEY_OIDC_CLIENT_ID is not set.");
    if (!clientSecret) problems.push("COSTKEY_OIDC_CLIENT_SECRET is not set.");
    if (allowedDomains.length === 0) {
      problems.push("COSTKEY_OIDC_ALLOWED_DOMAINS is not set. List the email domains that may sign in, for example example.com. Use * to allow any verified email.");
    }
    oidc = {
      issuer,
      clientId,
      clientSecret,
      scopes: (env["COSTKEY_OIDC_SCOPES"] ?? "").trim() || "openid email profile",
      allowedDomains,
      displayName: (env["COSTKEY_OIDC_NAME"] ?? "").trim() || "single sign-on",
    };
    if (!oidc.scopes.split(/\s+/).includes("openid")) problems.push("COSTKEY_OIDC_SCOPES must include openid.");
  }

  for (const problem of problems) logOnce(problem);
  return { mode, defaultRole, iap, oidc, problems };
}

export function authSettings(): AuthSettings {
  return readAuthSettings(process.env);
}

export function ssoEnabled(settings: AuthSettings = authSettings()): boolean {
  return settings.mode !== "password";
}

/** Log the sign-in mode at startup. Throws for an unknown COSTKEY_AUTH. */
export function reportAuthSettingsAtStartup(): void {
  const settings = authSettings();
  if (settings.mode === "password") return;
  if (settings.problems.length > 0) {
    console.error(`[costkey] Sign-in mode ${settings.mode} is misconfigured; nobody can sign in to the console until it is fixed. SDK ingest keeps working.`);
  } else {
    console.log(`[costkey] Sign-in mode: ${settings.mode}. Password sign-in is disabled. New members join as ${settings.defaultRole}.`);
  }
}
