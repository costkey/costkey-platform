import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/** Test fixtures for single sign-on: local signing keys and a stub OpenID provider. */
export function es256Key(kid = `kid_${randomBytes(4).toString("hex")}`): { kid: string; privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" } };
}

export function rs256Key(kid = `rsa_${randomBytes(4).toString("hex")}`): { kid: string; privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

export function signJwt(claims: Record<string, unknown>, key: { kid: string; privateKey: KeyObject }, alg = "ES256"): string {
  const header = Buffer.from(JSON.stringify({ alg, kid: key.kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = Buffer.from(`${header}.${payload}`);
  const signature = alg === "ES256"
    ? sign("sha256", input, { key: key.privateKey, dsaEncoding: "ieee-p1363" })
    : sign("sha256", input, key.privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

/**
 * A minimal OpenID provider: discovery, JWKS, and a token endpoint that
 * checks the client secret and the PKCE verifier before issuing an ID token.
 */
export async function startStubIssuer(options: { clientId: string; clientSecret: string }): Promise<{
  issuer: string;
  close: () => Promise<void>;
  /** Simulate the user approving at the provider: returns the code for this authorize URL. */
  approve: (authorizeUrl: string, claims: Record<string, unknown>) => string;
  tokenRequests: Array<Record<string, string>>;
}> {
  const key = rs256Key();
  const codes = new Map<string, { challenge: string; redirectUri: string; nonce: string; claims: Record<string, unknown> }>();
  const tokenRequests: Array<Record<string, string>> = [];
  let issuer = "";
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/.well-known/openid-configuration") {
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/jwks") { json(200, { keys: [key.jwk] }); return; }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const form = Object.fromEntries(new URLSearchParams(raw));
        tokenRequests.push(form);
        // RFC 6749 2.3.1: both halves are form-urlencoded before base64.
        const basic = Buffer.from(String(req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString("utf8");
        const [id = "", secret = ""] = basic.split(":").map((part) => decodeURIComponent(part.replace(/\+/g, " ")));
        if (id !== options.clientId || secret !== options.clientSecret) { json(401, { error: "invalid_client" }); return; }
        const grant = codes.get(form.code ?? "");
        codes.delete(form.code ?? "");
        if (!grant || form.grant_type !== "authorization_code" || form.redirect_uri !== grant.redirectUri) { json(400, { error: "invalid_grant" }); return; }
        const challenge = createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
        if (challenge !== grant.challenge) { json(400, { error: "invalid_grant", error_description: "PKCE verification failed" }); return; }
        const now = Math.floor(Date.now() / 1000);
        const idToken = signJwt({ iss: issuer, aud: options.clientId, iat: now, exp: now + 300, sub: "user-1", nonce: grant.nonce, ...grant.claims }, key, "RS256");
        json(200, { access_token: "at", token_type: "Bearer", id_token: idToken });
      });
      return;
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    issuer,
    tokenRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    approve: (authorizeUrl, claims) => {
      const url = new URL(authorizeUrl);
      assert.equal(url.origin + url.pathname, `${issuer}/authorize`);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("client_id"), options.clientId);
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        nonce: url.searchParams.get("nonce") ?? "",
        claims,
      });
      return code;
    },
  };
}
