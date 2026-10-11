import { test } from "node:test";
import assert from "node:assert/strict";
import { readAuthSettings, readAuthMode } from "../sso/config.js";
import { createIapJwks, verifyIapAssertion, IAP_ISSUER } from "../sso/iap.js";
import { JwksCache, TokenError, verifyJwt } from "../sso/jwt.js";
import { authorizationUrl, clearOidcCaches, completeLogin, discover, emailDomainAllowed, newFlow, OidcError } from "../sso/oidc.js";
import { isSdkPath, iapLogoutUrl, oidcRedirectUri } from "../sso/router.js";
import type { OidcSettings } from "../sso/config.js";
import { es256Key, signJwt, startStubIssuer } from "./helpers/sso-fixtures.js";

const AUDIENCE = "/projects/123456789/regions/asia-south1/backendServices/987654321";

function iapClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: IAP_ISSUER, aud: AUDIENCE, iat: now - 5, exp: now + 600, sub: "accounts.google.com:1", email: "Alice@Example.com", hd: "example.com", ...overrides };
}

/** A JWKS "endpoint" that counts how often it is fetched. */
function stubJwks(keys: Array<Record<string, unknown>>): { cache: JwksCache; fetches: () => number; setKeys: (next: Array<Record<string, unknown>>) => void } {
  let current = keys;
  let count = 0;
  const cache = createIapJwks("https://jwks.invalid/keys", async () => {
    count += 1;
    return new Response(JSON.stringify({ keys: current }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { cache, fetches: () => count, setKeys: (next) => { current = next; } };
}

test("IAP: a valid assertion yields the lower-cased email", async () => {
  const key = es256Key();
  const { cache } = stubJwks([key.jwk]);
  const identity = await verifyIapAssertion(signJwt(iapClaims(), key), { audiences: [AUDIENCE], jwks: cache });
  assert.equal(identity.email, "alice@example.com");
  assert.equal(identity.hostedDomain, "example.com");
});

test("IAP: wrong audience, expiry, issuer, missing header and bad signatures are rejected", async () => {
  const key = es256Key();
  const other = es256Key(key.kid);
  const { cache } = stubJwks([key.jwk]);
  const reject = async (assertion: unknown, code: string, audiences = [AUDIENCE]) => {
    await assert.rejects(verifyIapAssertion(assertion, { audiences, jwks: cache }), (error: unknown) => {
      assert.ok(error instanceof TokenError, String(error));
      assert.equal(error.code, code);
      return true;
    });
  };
  const now = Math.floor(Date.now() / 1000);
  await reject(signJwt(iapClaims({ aud: "/projects/1/global/backendServices/2" }), key), "bad_audience");
  await reject(signJwt(iapClaims({ exp: now - 120, iat: now - 700 }), key), "expired");
  await reject(signJwt(iapClaims({ iss: "https://accounts.google.com" }), key), "bad_issuer");
  await reject(signJwt(iapClaims({ iat: now + 600 }), key), "bad_iat");
  await reject(undefined, "missing");
  await reject("", "missing");
  await reject("not.a.jwt", "malformed");
  await reject(signJwt(iapClaims(), other), "bad_signature");
  await reject(signJwt(iapClaims({ email: undefined }), key), "no_email");
  await reject(signJwt(iapClaims(), key), "not_configured", []);
  // HS256 forged with any secret, and alg "none", are never accepted.
  const header = Buffer.from(JSON.stringify({ alg: "HS256", kid: key.kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(iapClaims())).toString("base64url");
  await reject(`${header}.${body}.c2lnbmF0dXJl`, "bad_alg");
  const none = Buffer.from(JSON.stringify({ alg: "none", kid: key.kid })).toString("base64url");
  await reject(`${none}.${body}.c2ln`, "bad_alg");
});

test("IAP: small clock skew is tolerated", async () => {
  const key = es256Key();
  const { cache } = stubJwks([key.jwk]);
  const now = Math.floor(Date.now() / 1000);
  const identity = await verifyIapAssertion(signJwt(iapClaims({ exp: now - 30, iat: now - 630 }), key), { audiences: [AUDIENCE], jwks: cache });
  assert.equal(identity.email, "alice@example.com");
});

test("IAP: any audience in a comma-separated COSTKEY_IAP_AUDIENCE is accepted", async () => {
  const settings = readAuthSettings({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: ` /projects/1/global/backendServices/2 , ${AUDIENCE}` });
  assert.deepEqual(settings.iap?.audiences, ["/projects/1/global/backendServices/2", AUDIENCE]);
  const key = es256Key();
  const { cache } = stubJwks([key.jwk]);
  const identity = await verifyIapAssertion(signJwt(iapClaims(), key), { audiences: settings.iap!.audiences, jwks: cache });
  assert.equal(identity.email, "alice@example.com");
});

test("JWKS: keys are cached, and an unknown kid refreshes once", async () => {
  const first = es256Key("first");
  const second = es256Key("second");
  const jwks = stubJwks([first.jwk]);
  const rules = { algorithms: ["ES256"], issuer: IAP_ISSUER, audiences: [AUDIENCE] };
  await verifyJwt(signJwt(iapClaims(), first), jwks.cache, rules);
  await verifyJwt(signJwt(iapClaims(), first), jwks.cache, rules);
  assert.equal(jwks.fetches(), 1);
  // Within the refresh floor an unknown kid does not refetch (junk tokens
  // cannot hammer Google).
  await assert.rejects(verifyJwt(signJwt(iapClaims(), second), jwks.cache, rules), (error: unknown) => error instanceof TokenError && error.code === "unknown_key");
  assert.equal(jwks.fetches(), 1);

  // Google rotates its keys: the new kid triggers one refresh.
  let fetches = 0;
  let keys: Array<Record<string, unknown>> = [first.jwk];
  const cache = new JwksCache("https://jwks.invalid/rotating", {
    minRefreshMs: 0,
    fetch: async () => { fetches += 1; return new Response(JSON.stringify({ keys })); },
  });
  await verifyJwt(signJwt(iapClaims(), first), cache, rules);
  keys = [first.jwk, second.jwk];
  await verifyJwt(signJwt(iapClaims(), second), cache, rules);
  assert.equal(fetches, 2);
  await verifyJwt(signJwt(iapClaims(), second), cache, rules);
  assert.equal(fetches, 2);
  await assert.rejects(verifyJwt(signJwt(iapClaims(), es256Key("unknown")), cache, rules), (error: unknown) => error instanceof TokenError && error.code === "unknown_key");
});

test("config: modes, default role and required settings", () => {
  assert.equal(readAuthMode({}), "password");
  assert.equal(readAuthMode({ COSTKEY_AUTH: " IAP " }), "iap");
  assert.throws(() => readAuthMode({ COSTKEY_AUTH: "saml" }), /COSTKEY_AUTH must be password, iap or oidc/);
  assert.equal(readAuthSettings({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE }).defaultRole, "developer");
  assert.equal(readAuthSettings({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE, COSTKEY_SSO_DEFAULT_ROLE: "Viewer" }).defaultRole, "viewer");
  assert.equal(readAuthSettings({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE, COSTKEY_SSO_DEFAULT_ROLE: "owner" }).defaultRole, "viewer");
  assert.equal(readAuthSettings({ COSTKEY_AUTH: "iap", COSTKEY_IAP_AUDIENCE: AUDIENCE }).problems.length, 0);
  assert.match(readAuthSettings({ COSTKEY_AUTH: "iap" }).problems.join(" "), /COSTKEY_IAP_AUDIENCE is not set/);
  const oidc = readAuthSettings({ COSTKEY_AUTH: "oidc", COSTKEY_OIDC_ISSUER: "https://idp.example.com/" });
  assert.match(oidc.problems.join(" "), /CLIENT_ID/);
  assert.match(oidc.problems.join(" "), /ALLOWED_DOMAINS/);
  assert.equal(oidc.oidc?.issuer, "https://idp.example.com");
  assert.equal(oidc.oidc?.scopes, "openid email profile");
  assert.match(readAuthSettings({ COSTKEY_AUTH: "oidc", COSTKEY_OIDC_ISSUER: "http://idp.example.com" }).problems.join(" "), /https/);
});

test("SDK paths bypass IAP; console paths do not", () => {
  for (const path of ["/api/v1/events", "/api/v1/sdk/policy/admit", "/api/v1/sdk/budget/rules", "/api/v1/projects/proj_1/config", "/api/v1/projects/proj_1/callgraph"]) {
    assert.equal(isSdkPath(path), true, path);
  }
  for (const path of ["/api/v1/projects/proj_1", "/api/v1/projects/proj_1/configs", "/api/v1/eventsx", "/auth/me", "/api/v1/team/invite"]) {
    assert.equal(isSdkPath(path), false, path);
  }
});

test("URLs: IAP logout and the OIDC redirect URI follow the base path", () => {
  const previous = { base: process.env["COSTKEY_BASE_PATH"], url: process.env["PUBLIC_URL"] };
  try {
    delete process.env["COSTKEY_BASE_PATH"];
    process.env["PUBLIC_URL"] = "https://costkey.example.com";
    assert.equal(iapLogoutUrl(), "/_gcp_iap/clear_login_cookie");
    assert.equal(oidcRedirectUri(), "https://costkey.example.com/auth/oidc/callback");
    process.env["PUBLIC_URL"] = "https://portal.example.com/costkey";
    assert.equal(iapLogoutUrl(), "/costkey/_gcp_iap/clear_login_cookie");
    assert.equal(oidcRedirectUri(), "https://portal.example.com/costkey/auth/oidc/callback");
  } finally {
    if (previous.base === undefined) delete process.env["COSTKEY_BASE_PATH"]; else process.env["COSTKEY_BASE_PATH"] = previous.base;
    if (previous.url === undefined) delete process.env["PUBLIC_URL"]; else process.env["PUBLIC_URL"] = previous.url;
  }
});

test("OIDC: email domain allowlist is exact", () => {
  assert.equal(emailDomainAllowed("a@example.com", ["example.com"]), true);
  assert.equal(emailDomainAllowed("a@sub.example.com", ["example.com"]), false);
  assert.equal(emailDomainAllowed("a@example.com.evil.io", ["example.com"]), false);
  assert.equal(emailDomainAllowed("a@anything.io", ["*"]), true);
});

test("OIDC: discovery, PKCE token exchange, ID token verification and domain allowlist", async () => {
  clearOidcCaches();
  const stub = await startStubIssuer({ clientId: "costkey-client", clientSecret: "s3cret value" });
  try {
    const settings: OidcSettings = {
      issuer: stub.issuer, clientId: "costkey-client", clientSecret: "s3cret value",
      scopes: "openid email profile", allowedDomains: ["example.com"], displayName: "Okta",
    };
    const discovery = await discover(stub.issuer);
    assert.equal(discovery.token_endpoint, `${stub.issuer}/token`);
    const redirectUri = "https://costkey.example.com/auth/oidc/callback";

    const flow = newFlow();
    const authorize = await authorizationUrl(settings, flow, redirectUri);
    const params = new URL(authorize).searchParams;
    assert.equal(params.get("response_type"), "code");
    assert.equal(params.get("scope"), "openid email profile");
    assert.equal(params.get("state"), flow.state);
    assert.equal(params.get("nonce"), flow.nonce);
    assert.equal(params.get("redirect_uri"), redirectUri);
    assert.notEqual(params.get("code_challenge"), flow.codeVerifier);

    const code = stub.approve(authorize, { email: "Bob@Example.com", email_verified: true, name: "Bob" });
    const identity = await completeLogin(settings, { code, codeVerifier: flow.codeVerifier, nonce: flow.nonce, redirectUri });
    assert.deepEqual(identity, { email: "bob@example.com", name: "Bob", subject: "user-1" });
    assert.equal(stub.tokenRequests.at(-1)?.code_verifier, flow.codeVerifier);

    const expectFailure = async (claims: Record<string, unknown>, code: string, mutate: (input: { nonce: string; verifier: string }) => { nonce: string; verifier: string } = (input) => input) => {
      const attempt = newFlow();
      const url = await authorizationUrl(settings, attempt, redirectUri);
      const granted = stub.approve(url, claims);
      const input = mutate({ nonce: attempt.nonce, verifier: attempt.codeVerifier });
      await assert.rejects(
        completeLogin(settings, { code: granted, codeVerifier: input.verifier, nonce: input.nonce, redirectUri }),
        (error: unknown) => { assert.ok(error instanceof OidcError, String(error)); assert.equal(error.code, code, error.message); return true; },
      );
    };
    await expectFailure({ email: "mallory@evil.io", email_verified: true }, "domain");
    await expectFailure({ email: "eve@example.com", email_verified: false }, "email_unverified");
    await expectFailure({ name: "No Email" }, "no_email");
    await expectFailure({ email: "bob@example.com", aud: "another-client" }, "id_token");
    await expectFailure({ email: "bob@example.com", iss: "https://elsewhere.example.com" }, "id_token");
    await expectFailure({ email: "bob@example.com" }, "id_token", (input) => ({ ...input, nonce: "a-different-nonce-value" }));
    await expectFailure({ email: "bob@example.com" }, "token", (input) => ({ ...input, verifier: "wrong-verifier" }));
    // email_verified absent is accepted (Entra ID does not send it).
    const attempt = newFlow();
    const url = await authorizationUrl(settings, attempt, redirectUri);
    const verifiedAbsent = await completeLogin(settings, { code: stub.approve(url, { email: "carol@example.com" }), codeVerifier: attempt.codeVerifier, nonce: attempt.nonce, redirectUri });
    assert.equal(verifiedAbsent.email, "carol@example.com");
  } finally {
    await stub.close();
    clearOidcCaches();
  }
});

test("OIDC: discovery must name the configured issuer", async () => {
  clearOidcCaches();
  const stub = await startStubIssuer({ clientId: "c", clientSecret: "s" });
  try {
    await assert.rejects(discover(`${stub.issuer}/`.replace(/\/$/, "") + "/other"), OidcError);
  } finally {
    await stub.close();
    clearOidcCaches();
  }
});
