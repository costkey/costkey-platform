/**
 * Console sign-in for COSTKEY_AUTH=iap and COSTKEY_AUTH=oidc, mounted by
 * index.ts next to the password auth router:
 *
 *   app.use(authMiddleware(pool));
 *   app.use(ssoSessionMiddleware(pool));  // IAP: identity from the signed header
 *   ...
 *   app.use(createSsoRouter(pool));       // /auth/config, OIDC routes, password guard
 *   app.use(createAuthRouter(pool));
 */
import { Router as createRouter, type NextFunction, type Request, type Response, type Router } from "express";
import type pg from "pg";
import { clearSessionCookie, issueSessionCookie, safeInternalReturnTo, signSsoFlowState, verifySsoFlowState, type AuthUser } from "../auth.js";
import { rateLimit } from "../middleware.js";
import { secureCookies } from "../public-url.js";
import { authSettings, type AuthSettings } from "./config.js";
import { IAP_ASSERTION_HEADER, verifyIapAssertion } from "./iap.js";
import { constantTimeEqual, decodeJwt, TokenError } from "./jwt.js";
import { authorizationUrl, completeLogin, newFlow, OidcError } from "./oidc.js";
import { findOrProvisionSsoUser, SsoAccessError } from "./provision.js";
import { appPath, cookiePath, publicAppUrl } from "./urls.js";
import { isApiTokenHeader } from "../api-tokens.js";

/** What the console needs to draw its sign-in page. */
export interface AuthConfigResponse {
  mode: AuthSettings["mode"];
  /** Email/password forms and signup are available. */
  password: boolean;
  /** "Continue with GitHub" is available. */
  github: boolean;
  /** False when an SSO mode is missing settings; nobody can sign in. */
  configured: boolean;
  oidc?: { name: string; startPath: string };
  iap?: {
    /** Where to send the browser after sign-out, so IAP forgets the Google session too. */
    logoutUrl: string;
    /** Why this request has or lacks an IAP identity. */
    status: IapStatus;
  };
}

export type IapStatus = "signed_in" | "missing_assertion" | "invalid_assertion" | "access_removed" | "not_configured" | "error";

type SsoRequest = Request & { user?: AuthUser; ssoStatus?: IapStatus };

/**
 * SDK routes authenticate with the DSN and are not behind IAP. The load
 * balancer must route them around IAP; here they skip the IAP check.
 */
const SDK_PATHS = [
  /^\/api\/v1\/events(?:\/|$)/,
  /^\/api\/v1\/sdk(?:\/|$)/,
  /^\/api\/v1\/projects\/[^/]+\/(?:config|callgraph)\/?$/,
];
const NO_IDENTITY_PATHS = [/^\/health$/, /^\/ready$/, /^\/assets\//, /^\/auth\/logout$/];

export function isSdkPath(path: string): boolean {
  return SDK_PATHS.some((pattern) => pattern.test(path));
}

/** authMiddleware has already verified the token; this only reads its type. */
function isCliBearer(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  try {
    return decodeJwt(header.slice(7).trim()).claims.type === "cli";
  } catch {
    return false;
  }
}

const OIDC_FLOW_COOKIE = "ck_oidc_flow";
const OIDC_FLOW_TTL_SECONDS = 10 * 60;

export function oidcRedirectUri(): string {
  return `${publicAppUrl()}/auth/oidc/callback`;
}

export function iapLogoutUrl(): string {
  return appPath("/_gcp_iap/clear_login_cookie");
}

const iapWarnings = new Map<string, number>();
function warnIap(message: string): void {
  // Log each distinct failure at most once a minute.
  const now = Date.now();
  if ((iapWarnings.get(message) ?? 0) > now - 60_000) return;
  iapWarnings.set(message, now);
  if (iapWarnings.size > 500) iapWarnings.clear();
  console.warn(`[costkey] IAP sign-in: ${message}`);
}

/**
 * In IAP mode every console request carries Google's signed assertion. A
 * valid assertion signs the person in (provisioning them on first visit) and
 * refreshes the session cookie when it belongs to someone else. Without a
 * valid assertion, a session cookie alone is not accepted: IAP is the source
 * of truth. CLI bearer tokens still work, and SDK routes are left alone.
 */
export function ssoSessionMiddleware(pool: pg.Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const settings = authSettings();
    if (settings.mode !== "iap") { next(); return; }
    const ssoReq = req as SsoRequest;
    if (isSdkPath(req.path) || NO_IDENTITY_PATHS.some((pattern) => pattern.test(req.path))) { next(); return; }
    // A personal access token stands on its own: authMiddleware has already
    // accepted or refused it, and an IAP identity must not widen it.
    if (isApiTokenHeader(req.headers.authorization)) { next(); return; }

    const cookieSession = Boolean(req.cookies?.["ck_token"]);
    const bearer = !cookieSession && isCliBearer(req.headers.authorization);
    const assertion = req.headers[IAP_ASSERTION_HEADER];

    if (settings.problems.length > 0 || !assertion) {
      ssoReq.ssoStatus = settings.problems.length > 0 ? "not_configured" : "missing_assertion";
      // Only a CLI token (issued after an IAP sign-in) works without IAP.
      // A session token copied into the Authorization header does not.
      if (!bearer) delete ssoReq.user;
      next();
      return;
    }

    try {
      const identity = await verifyIapAssertion(assertion, { audiences: settings.iap?.audiences ?? [] });
      if (ssoReq.user && ssoReq.user.email.trim().toLowerCase() === identity.email) {
        ssoReq.ssoStatus = "signed_in";
        next();
        return;
      }
      const user = await findOrProvisionSsoUser(pool, { email: identity.email }, settings.defaultRole);
      if (user.outcome !== "existing") console.log(`[costkey] IAP sign-in provisioned ${user.email} as ${user.role} (${user.outcome})`);
      ssoReq.user = { id: user.id, email: user.email, name: user.name, orgId: user.orgId, role: user.role };
      (req as Request & { authKind?: string }).authKind = "session";
      ssoReq.ssoStatus = "signed_in";
      issueSessionCookie(res, user);
    } catch (error) {
      delete ssoReq.user;
      if (error instanceof SsoAccessError) {
        ssoReq.ssoStatus = "access_removed";
        warnIap(error.message);
      } else if (error instanceof TokenError) {
        ssoReq.ssoStatus = "invalid_assertion";
        warnIap(`rejected assertion (${error.code}): ${error.message}`);
      } else {
        ssoReq.ssoStatus = "error";
        console.error("[costkey] IAP sign-in error:", error);
      }
    }
    next();
  };
}

function oidcFlowCookieOptions() {
  return { httpOnly: true, secure: secureCookies(), sameSite: "lax" as const, path: cookiePath(), maxAge: OIDC_FLOW_TTL_SECONDS * 1000 };
}

function loginError(res: Response, code: string): void {
  res.redirect(appPath(`/login?error=${encodeURIComponent(code)}`));
}

export function createSsoRouter(pool: pg.Pool): Router {
  const router = createRouter();

  router.get("/auth/config", (req: Request, res: Response) => {
    const settings = authSettings();
    const body: AuthConfigResponse = {
      mode: settings.mode,
      password: settings.mode === "password",
      github: settings.mode === "password" && Boolean(process.env["GITHUB_CLIENT_ID"]),
      configured: settings.problems.length === 0,
    };
    if (settings.mode === "oidc") body.oidc = { name: settings.oidc?.displayName ?? "single sign-on", startPath: "/auth/oidc/start" };
    if (settings.mode === "iap") {
      body.iap = { logoutUrl: iapLogoutUrl(), status: (req as SsoRequest).ssoStatus ?? "missing_assertion" };
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(body);
  });

  // Password, signup and GitHub sign-in are switched off on the server in
  // SSO modes, not just hidden in the console.
  const passwordOnly = (req: Request, res: Response, next: NextFunction): void => {
    const settings = authSettings();
    if (settings.mode === "password") { next(); return; }
    res.status(403).json({
      error: `Password and GitHub sign-in are disabled. This server uses ${settings.mode === "iap" ? "Identity-Aware Proxy" : settings.oidc?.displayName ?? "single sign-on"}.`,
      code: "password_auth_disabled",
    });
  };
  router.post("/auth/signup", passwordOnly);
  router.post("/auth/login", passwordOnly);
  router.get("/auth/github", passwordOnly);
  router.get("/auth/github/callback", passwordOnly);

  // IAP sign-out: clear the CostKey session and send the browser to IAP's
  // clear-login-cookie path. Without that, the next request signs back in.
  router.post("/auth/logout", (_req: Request, res: Response, next: NextFunction) => {
    const settings = authSettings();
    if (settings.mode !== "iap") { next(); return; }
    clearSessionCookie(res);
    res.json({ ok: true, redirectTo: iapLogoutUrl() });
  });

  // ── OIDC ──
  // Generous: without trust proxy every user behind a load balancer shares one key.
  router.use("/auth/oidc", rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

  router.get("/auth/oidc/start", async (req: Request, res: Response) => {
    const settings = authSettings();
    if (settings.mode !== "oidc" || !settings.oidc) { res.status(404).json({ error: "Not found" }); return; }
    if (settings.problems.length > 0) { loginError(res, "oidc_not_configured"); return; }
    const returnTo = safeInternalReturnTo(req.query["returnTo"]) ?? "/";
    const flow = newFlow();
    try {
      const url = await authorizationUrl(settings.oidc, flow, oidcRedirectUri());
      res.cookie(OIDC_FLOW_COOKIE, signSsoFlowState({
        state: flow.state, nonce: flow.nonce, verifier: flow.codeVerifier, returnTo,
      }, OIDC_FLOW_TTL_SECONDS), oidcFlowCookieOptions());
      res.redirect(url);
    } catch (error) {
      console.error("[costkey] OIDC sign-in could not start:", error instanceof Error ? error.message : error);
      loginError(res, "oidc_unavailable");
    }
  });

  router.get("/auth/oidc/callback", async (req: Request, res: Response) => {
    const settings = authSettings();
    if (settings.mode !== "oidc" || !settings.oidc) { res.status(404).json({ error: "Not found" }); return; }
    const flow = verifySsoFlowState(req.cookies?.[OIDC_FLOW_COOKIE]);
    // One shot: the flow cookie is cleared whatever happens next.
    res.clearCookie(OIDC_FLOW_COOKIE, { ...oidcFlowCookieOptions(), maxAge: undefined });
    const state = typeof req.query["state"] === "string" ? req.query["state"] : "";
    if (!flow || typeof flow.state !== "string" || typeof flow.nonce !== "string" || typeof flow.verifier !== "string"
      || !constantTimeEqual(flow.state, state)) {
      loginError(res, "oidc_state");
      return;
    }
    if (typeof req.query["error"] === "string") {
      console.warn(`[costkey] OIDC provider returned ${req.query["error"]}: ${String(req.query["error_description"] ?? "")}`);
      loginError(res, "oidc_denied");
      return;
    }
    const code = typeof req.query["code"] === "string" ? req.query["code"] : "";
    if (!code) { loginError(res, "oidc_denied"); return; }
    try {
      const identity = await completeLogin(settings.oidc, {
        code, codeVerifier: flow.verifier, nonce: flow.nonce, redirectUri: oidcRedirectUri(),
      });
      const user = await findOrProvisionSsoUser(pool, identity, settings.defaultRole);
      if (user.outcome !== "existing") console.log(`[costkey] OIDC sign-in provisioned ${user.email} as ${user.role} (${user.outcome})`);
      issueSessionCookie(res, user);
      const returnTo = safeInternalReturnTo(flow.returnTo) ?? "/";
      res.redirect(appPath(user.outcome === "created_workspace" && returnTo === "/" ? "/onboarding" : returnTo));
    } catch (error) {
      if (error instanceof SsoAccessError) {
        console.warn(`[costkey] OIDC sign-in refused: ${error.message}`);
        loginError(res, "access_removed");
      } else if (error instanceof OidcError) {
        const code = error.code === "domain" ? "oidc_domain"
          : error.code === "email_unverified" ? "oidc_email_unverified"
            : error.code === "no_email" ? "oidc_no_email"
              : "oidc_failed";
        console.warn(`[costkey] OIDC sign-in failed (${error.code}): ${error.message}`);
        loginError(res, code);
      } else {
        console.error("[costkey] OIDC callback error:", error);
        loginError(res, "oidc_failed");
      }
    }
  });

  return router;
}
