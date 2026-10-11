/**
 * Just enough JOSE to verify identity tokens from IAP and OIDC providers with
 * Node's crypto: compact JWS parsing, asymmetric signature checks against a
 * JWK, registered claim checks, and a JWKS cache that refreshes on an unknown
 * key ID. Symmetric ("HS*") and unsigned ("none") tokens are always rejected.
 */
import { constants, createPublicKey, timingSafeEqual, verify, type KeyObject, type webcrypto } from "node:crypto";

export type JsonWebKey = webcrypto.JsonWebKey;

export class TokenError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TokenError";
  }
}

export interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
  [key: string]: unknown;
}

export type JwtClaims = Record<string, unknown>;

export interface DecodedJwt {
  header: JwtHeader;
  claims: JwtClaims;
  signingInput: Buffer;
  signature: Buffer;
}

const ALGORITHMS: Record<string, { kty: string; hash: string | null; ecdsa?: boolean; pss?: number; crv?: string }> = {
  ES256: { kty: "EC", hash: "sha256", ecdsa: true, crv: "P-256" },
  ES384: { kty: "EC", hash: "sha384", ecdsa: true, crv: "P-384" },
  RS256: { kty: "RSA", hash: "sha256" },
  RS384: { kty: "RSA", hash: "sha384" },
  RS512: { kty: "RSA", hash: "sha512" },
  PS256: { kty: "RSA", hash: "sha256", pss: 32 },
  PS384: { kty: "RSA", hash: "sha384", pss: 48 },
  PS512: { kty: "RSA", hash: "sha512", pss: 64 },
  EdDSA: { kty: "OKP", hash: null },
};

export const ASYMMETRIC_ALGORITHMS = Object.keys(ALGORITHMS);

function base64UrlJson(part: string, what: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new TokenError("malformed", `Token ${what} is not a JSON object`);
}

export function decodeJwt(token: string): DecodedJwt {
  if (typeof token !== "string" || token.length > 16_384) throw new TokenError("malformed", "Token is missing or too long");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part)) || !parts[0] || !parts[1] || !parts[2]) {
    throw new TokenError("malformed", "Token is not a compact JWS");
  }
  return {
    header: base64UrlJson(parts[0], "header"),
    claims: base64UrlJson(parts[1], "payload"),
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
    signature: Buffer.from(parts[2], "base64url"),
  };
}

/** Verify the token's signature with one JWK. Throws TokenError on failure. */
export function verifySignature(decoded: DecodedJwt, jwk: JsonWebKey, allowed: readonly string[]): void {
  const alg = typeof decoded.header.alg === "string" ? decoded.header.alg : "";
  const spec = ALGORITHMS[alg];
  if (!spec || !allowed.includes(alg)) throw new TokenError("bad_alg", `Token algorithm ${alg || "(none)"} is not accepted`);
  if (jwk.kty !== spec.kty) throw new TokenError("bad_key", `Key type ${String(jwk.kty)} does not match ${alg}`);
  if (typeof jwk.alg === "string" && jwk.alg !== alg) throw new TokenError("bad_key", `Key is for ${jwk.alg}, token uses ${alg}`);
  if (spec.crv && jwk.crv !== spec.crv) throw new TokenError("bad_key", `Key curve ${String(jwk.crv)} does not match ${alg}`);
  if (typeof jwk.use === "string" && jwk.use !== "sig") throw new TokenError("bad_key", "Key is not a signing key");
  let key: KeyObject;
  try {
    // Only the public members are passed so a private JWK can never be used.
    const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicJwk } = jwk;
    key = createPublicKey({ key: publicJwk, format: "jwk" });
  } catch {
    throw new TokenError("bad_key", "Key could not be imported");
  }
  const ok = spec.ecdsa
    ? verify(spec.hash, decoded.signingInput, { key, dsaEncoding: "ieee-p1363" }, decoded.signature)
    : spec.pss
      ? verify(spec.hash, decoded.signingInput, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: spec.pss }, decoded.signature)
      : verify(spec.hash, decoded.signingInput, key, decoded.signature);
  if (!ok) throw new TokenError("bad_signature", "Token signature is invalid");
}

/** Compare two strings without leaking where they differ. */
export function constantTimeEqual(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || expected.length === 0) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ClaimRules {
  issuer: string;
  /** The token's aud (string or array) must contain one of these. */
  audiences: readonly string[];
  nowSeconds?: number;
  /** Allowed clock skew in seconds. */
  skewSeconds?: number;
  /** Reject tokens issued longer ago than this, in seconds. */
  maxAgeSeconds?: number;
}

export function checkClaims(claims: JwtClaims, rules: ClaimRules): void {
  const now = rules.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = rules.skewSeconds ?? 60;
  if (claims.iss !== rules.issuer) throw new TokenError("bad_issuer", `Token issuer ${String(claims.iss)} is not ${rules.issuer}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((value) => typeof value === "string" && rules.audiences.includes(value))) {
    throw new TokenError("bad_audience", `Token audience ${JSON.stringify(claims.aud)} is not accepted`);
  }
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw new TokenError("bad_exp", "Token has no expiry");
  if (now - skew >= claims.exp) throw new TokenError("expired", "Token has expired");
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) throw new TokenError("bad_iat", "Token has no issue time");
  if (claims.iat > now + skew) throw new TokenError("bad_iat", "Token was issued in the future");
  if (rules.maxAgeSeconds !== undefined && claims.iat < now - rules.maxAgeSeconds - skew) {
    throw new TokenError("bad_iat", "Token was issued too long ago");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + skew) throw new TokenError("not_yet_valid", "Token is not valid yet");
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A JSON Web Key Set fetched over HTTPS and cached. An unknown key ID forces
 * a refresh, at most once per `minRefreshMs`, so key rotation is picked up
 * immediately without letting junk tokens hammer the provider.
 */
export class JwksCache {
  private keys = new Map<string, JsonWebKey>();
  private anonymous: JsonWebKey[] = [];
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly options: { ttlMs?: number; minRefreshMs?: number; fetch?: FetchLike } = {},
  ) {}

  get source(): string {
    return this.url;
  }

  private async refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = (async () => {
        const fetchImpl = this.options.fetch ?? fetch;
        const response = await fetchImpl(this.url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`JWKS ${this.url} returned HTTP ${response.status}`);
        const body = await response.json() as { keys?: unknown };
        if (!body || !Array.isArray(body.keys)) throw new Error(`JWKS ${this.url} has no keys array`);
        const keys = new Map<string, JsonWebKey>();
        const anonymous: JsonWebKey[] = [];
        for (const entry of body.keys) {
          if (!entry || typeof entry !== "object") continue;
          const jwk = entry as JsonWebKey & { kid?: unknown };
          if (typeof jwk.kid === "string" && jwk.kid) keys.set(jwk.kid, jwk);
          else anonymous.push(jwk);
        }
        this.keys = keys;
        this.anonymous = anonymous;
        this.fetchedAt = Date.now();
      })().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  /** Candidate keys for a token header: the kid's key, or every key without a kid. */
  async keysFor(kid: unknown): Promise<JsonWebKey[]> {
    const ttl = this.options.ttlMs ?? 60 * 60 * 1000;
    const minRefresh = this.options.minRefreshMs ?? 30 * 1000;
    const age = Date.now() - this.fetchedAt;
    if (this.fetchedAt === 0 || age > ttl) await this.refresh();
    const lookup = () => (typeof kid === "string" && kid
      ? (this.keys.has(kid) ? [this.keys.get(kid)!] : [])
      : [...this.anonymous, ...this.keys.values()]);
    let found = lookup();
    if (found.length === 0 && Date.now() - this.fetchedAt >= minRefresh) {
      await this.refresh();
      found = lookup();
    }
    return found;
  }
}

/** Verify signature (via the JWKS) and registered claims. Returns the claims. */
export async function verifyJwt(
  token: string,
  jwks: JwksCache,
  rules: ClaimRules & { algorithms: readonly string[] },
): Promise<JwtClaims> {
  const decoded = decodeJwt(token);
  const alg = typeof decoded.header.alg === "string" ? decoded.header.alg : "";
  if (!rules.algorithms.includes(alg) || !ALGORITHMS[alg]) throw new TokenError("bad_alg", `Token algorithm ${alg || "(none)"} is not accepted`);
  let keys: JsonWebKey[];
  try {
    keys = await jwks.keysFor(decoded.header.kid);
  } catch (error) {
    throw new TokenError("jwks_unavailable", `Signing keys could not be fetched from ${jwks.source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (keys.length === 0) throw new TokenError("unknown_key", `No signing key ${String(decoded.header.kid ?? "")} at ${jwks.source}`);
  let lastError: unknown = null;
  let verified = false;
  for (const key of keys) {
    try {
      verifySignature(decoded, key, rules.algorithms);
      verified = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!verified) throw lastError instanceof TokenError ? lastError : new TokenError("bad_signature", "Token signature is invalid");
  checkClaims(decoded.claims, rules);
  return decoded.claims;
}
