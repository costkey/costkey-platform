/**
 * Identity-Aware Proxy: Google signs every request it lets through with an
 * ES256 JWT in x-goog-iap-jwt-assertion. Only that signed assertion is
 * trusted. The unsigned x-goog-authenticated-user-email header is ignored,
 * because anything that reaches the service without IAP could set it.
 * https://cloud.google.com/iap/docs/signed-headers-howto
 */
import { JwksCache, TokenError, verifyJwt, type FetchLike } from "./jwt.js";

export const IAP_ASSERTION_HEADER = "x-goog-iap-jwt-assertion";
export const IAP_ISSUER = "https://cloud.google.com/iap";
export const IAP_JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk";

export interface IapIdentity {
  email: string;
  subject: string;
  hostedDomain: string | null;
}

let sharedJwks: JwksCache | null = null;

/** The process-wide cache of Google's IAP keys. Tests can inject their own. */
export function iapJwks(): JwksCache {
  sharedJwks ??= new JwksCache(IAP_JWKS_URL);
  return sharedJwks;
}

/** Replace the IAP key source (tests stub Google's JWKS with a local key). */
export function setIapJwksForTesting(cache: JwksCache | null): void {
  sharedJwks = cache;
}

export function createIapJwks(url: string = IAP_JWKS_URL, fetchImpl?: FetchLike): JwksCache {
  return new JwksCache(url, { fetch: fetchImpl });
}

export async function verifyIapAssertion(
  assertion: unknown,
  options: { audiences: readonly string[]; jwks?: JwksCache; nowSeconds?: number },
): Promise<IapIdentity> {
  if (typeof assertion !== "string" || !assertion) throw new TokenError("missing", "No IAP assertion header on the request");
  if (options.audiences.length === 0) throw new TokenError("not_configured", "COSTKEY_IAP_AUDIENCE is not set");
  const claims = await verifyJwt(assertion, options.jwks ?? iapJwks(), {
    algorithms: ["ES256"],
    issuer: IAP_ISSUER,
    audiences: options.audiences,
    nowSeconds: options.nowSeconds,
    skewSeconds: 60,
  });
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  // IAP emails can carry an "accounts.google.com:" prefix in some flows.
  const normalized = email.replace(/^accounts\.google\.com:/, "");
  if (!normalized || !normalized.includes("@")) throw new TokenError("no_email", "IAP assertion has no email claim");
  return {
    email: normalized,
    subject: typeof claims.sub === "string" ? claims.sub : "",
    hostedDomain: typeof claims.hd === "string" ? claims.hd : null,
  };
}
