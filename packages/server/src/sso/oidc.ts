/**
 * OpenID Connect authorization code flow with PKCE (S256), state and nonce.
 * Provider endpoints come from discovery at COSTKEY_OIDC_ISSUER. The ID token
 * from the token endpoint is still verified in full (signature via JWKS, iss,
 * aud, azp, nonce, exp, iat): the TLS channel alone is not relied on.
 */
import { createHash, randomBytes } from "node:crypto";
import type { OidcSettings } from "./config.js";
import { constantTimeEqual, JwksCache, TokenError, verifyJwt, ASYMMETRIC_ALGORITHMS } from "./jwt.js";

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OidcIdentity {
  email: string;
  name: string | null;
  subject: string;
}

export class OidcError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OidcError";
  }
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const discoveryCache = new Map<string, { at: number; value: OidcDiscovery }>();
const jwksCaches = new Map<string, JwksCache>();

export function clearOidcCaches(): void {
  discoveryCache.clear();
  jwksCaches.clear();
}

function requireUrl(value: unknown, field: string, issuer: string): string {
  if (typeof value !== "string") throw new OidcError("discovery", `Discovery for ${issuer} has no ${field}`);
  let url: URL;
  try { url = new URL(value); } catch { throw new OidcError("discovery", `Discovery ${field} is not a URL`); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new OidcError("discovery", `Discovery ${field} must use https`);
  }
  return value;
}

export async function discover(issuer: string): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.value;
  const url = `${issuer}/.well-known/openid-configuration`;
  let body: Record<string, unknown>;
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json() as Record<string, unknown>;
  } catch (error) {
    throw new OidcError("discovery", `OIDC discovery failed at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The discovered issuer must be exactly the configured one (OIDC Discovery 4.3).
  if (typeof body.issuer !== "string" || body.issuer.replace(/\/+$/, "") !== issuer) {
    throw new OidcError("discovery", `Discovery issuer ${String(body.issuer)} does not match COSTKEY_OIDC_ISSUER ${issuer}`);
  }
  const value: OidcDiscovery = {
    issuer: body.issuer,
    authorization_endpoint: requireUrl(body.authorization_endpoint, "authorization_endpoint", issuer),
    token_endpoint: requireUrl(body.token_endpoint, "token_endpoint", issuer),
    jwks_uri: requireUrl(body.jwks_uri, "jwks_uri", issuer),
    id_token_signing_alg_values_supported: Array.isArray(body.id_token_signing_alg_values_supported)
      ? body.id_token_signing_alg_values_supported.filter((alg): alg is string => typeof alg === "string") : undefined,
    token_endpoint_auth_methods_supported: Array.isArray(body.token_endpoint_auth_methods_supported)
      ? body.token_endpoint_auth_methods_supported.filter((method): method is string => typeof method === "string") : undefined,
    code_challenge_methods_supported: Array.isArray(body.code_challenge_methods_supported)
      ? body.code_challenge_methods_supported.filter((method): method is string => typeof method === "string") : undefined,
  };
  discoveryCache.set(issuer, { at: Date.now(), value });
  return value;
}

function jwksFor(uri: string): JwksCache {
  let cache = jwksCaches.get(uri);
  if (!cache) {
    cache = new JwksCache(uri);
    jwksCaches.set(uri, cache);
  }
  return cache;
}

export interface OidcFlow {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export function newFlow(): OidcFlow {
  return {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    codeVerifier: randomBytes(48).toString("base64url"),
  };
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function authorizationUrl(settings: OidcSettings, flow: OidcFlow, redirectUri: string): Promise<string> {
  const discovery = await discover(settings.issuer);
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", settings.scopes);
  url.searchParams.set("state", flow.state);
  url.searchParams.set("nonce", flow.nonce);
  url.searchParams.set("code_challenge", codeChallenge(flow.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Exchange the authorization code for tokens and return the verified identity. */
export async function completeLogin(
  settings: OidcSettings,
  params: { code: string; codeVerifier: string; nonce: string; redirectUri: string },
): Promise<OidcIdentity> {
  const discovery = await discover(settings.issuer);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const methods = discovery.token_endpoint_auth_methods_supported;
  // client_secret_basic is the spec default; use post only when it is the
  // provider's only advertised option.
  if (methods && !methods.includes("client_secret_basic") && methods.includes("client_secret_post")) {
    form.set("client_id", settings.clientId);
    form.set("client_secret", settings.clientSecret);
  } else {
    const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
    headers["Authorization"] = `Basic ${Buffer.from(`${encode(settings.clientId)}:${encode(settings.clientSecret)}`).toString("base64")}`;
    form.set("client_id", settings.clientId);
  }
  let tokenBody: Record<string, unknown>;
  try {
    const response = await fetch(discovery.token_endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(10_000) });
    tokenBody = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${typeof tokenBody.error === "string" ? tokenBody.error : ""} ${typeof tokenBody.error_description === "string" ? tokenBody.error_description : ""}`.trim());
    }
  } catch (error) {
    throw new OidcError("token", `OIDC token exchange failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof tokenBody.id_token !== "string") throw new OidcError("token", "OIDC token response has no id_token");
  return verifyIdToken(settings, discovery, tokenBody.id_token, params.nonce);
}

export async function verifyIdToken(
  settings: OidcSettings,
  discovery: OidcDiscovery,
  idToken: string,
  expectedNonce: string,
  nowSeconds?: number,
): Promise<OidcIdentity> {
  const advertised = discovery.id_token_signing_alg_values_supported;
  const algorithms = advertised?.length
    ? ASYMMETRIC_ALGORITHMS.filter((alg) => advertised.includes(alg))
    : ["RS256"];
  let claims: Record<string, unknown>;
  try {
    claims = await verifyJwt(idToken, jwksFor(discovery.jwks_uri), {
      algorithms,
      issuer: discovery.issuer,
      audiences: [settings.clientId],
      nowSeconds,
      skewSeconds: 60,
      maxAgeSeconds: 10 * 60,
    });
  } catch (error) {
    if (error instanceof TokenError) throw new OidcError("id_token", `ID token rejected: ${error.message}`);
    throw error;
  }
  // With several audiences, the authorized party must be this client.
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== settings.clientId) {
    throw new OidcError("id_token", "ID token azp is not this client");
  }
  if (claims.azp !== undefined && claims.azp !== settings.clientId) {
    throw new OidcError("id_token", "ID token azp is not this client");
  }
  if (!constantTimeEqual(expectedNonce, claims.nonce)) throw new OidcError("id_token", "ID token nonce does not match");
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new OidcError("no_email", "ID token has no email claim. Request the email scope, and on Entra ID add the email optional claim.");
  }
  // Require a verified email whenever the provider says whether it is.
  if (claims.email_verified !== undefined && claims.email_verified !== true && claims.email_verified !== "true") {
    throw new OidcError("email_unverified", `The provider has not verified ${email}`);
  }
  if (!emailDomainAllowed(email, settings.allowedDomains)) {
    throw new OidcError("domain", `${email} is not in COSTKEY_OIDC_ALLOWED_DOMAINS`);
  }
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : null;
  return { email, name, subject: typeof claims.sub === "string" ? claims.sub : "" };
}

/** Exact domain match on the part after the last @. "*" allows any domain. */
export function emailDomainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.includes("*")) return true;
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return Boolean(domain) && allowedDomains.includes(domain);
}
