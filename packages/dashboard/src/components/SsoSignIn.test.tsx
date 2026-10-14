import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { AuthContext, type AuthState } from "../contexts/auth-state";
import {
  iapStatusMessage,
  oidcStartHref,
  primeAuthConfig,
  signedInDestination,
  ssoErrorMessage,
  type AuthConfig,
} from "../authConfig";

beforeAll(() => {
  const location = { pathname: "/login", search: "", hash: "", href: "http://localhost/login", origin: "http://localhost" };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location,
      history: { state: null, length: 1, pushState: () => {}, replaceState: () => {}, go: () => {}, back: () => {}, forward: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      localStorage: { getItem: () => null, setItem: () => {} },
    },
  });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { defaultView: globalThis.window, documentElement: { dataset: {} } } });
});

afterEach(() => primeAuthConfig(null));

function auth(overrides: Partial<AuthState> = {}): AuthState {
  return {
    user: null, org: null, projects: [], members: [], workspaceSettings: null, loading: false, error: null,
    login: async () => false, signup: async () => null, logout: async () => {}, refresh: async () => {},
    currentProjectId: null, setCurrentProjectId: () => {},
    ...overrides,
  };
}

async function renderLogin(config: AuthConfig | null, url = "/login", state: Partial<AuthState> = {}): Promise<string> {
  primeAuthConfig(config);
  const { default: Login } = await import("../pages/Login");
  const tree: ReactNode = createElement(
    MemoryRouter,
    { initialEntries: [url] },
    createElement(AuthContext.Provider, { value: auth(state) }, createElement(Login)),
  );
  return renderToString(tree);
}

const IAP: AuthConfig = {
  mode: "iap", password: false, github: false, configured: true,
  iap: { logoutUrl: "/_gcp_iap/clear_login_cookie", status: "missing_assertion" },
};
const OIDC: AuthConfig = {
  mode: "oidc", password: false, github: false, configured: true,
  oidc: { name: "Okta", startPath: "/auth/oidc/start" },
};

describe("login page per sign-in mode", () => {
  it("password mode shows the email and password form", async () => {
    const html = await renderLogin({ mode: "password", password: true, github: true, configured: true });
    expect(html).toContain('type="password"');
    expect(html).toContain("Continue with GitHub");
  });

  it("shows no password form before the config has loaded", async () => {
    const html = await renderLogin(null);
    expect(html).not.toContain('type="password"');
    expect(html).toContain("Checking how this workspace signs in");
  });

  it("IAP mode shows no password form, and explains a missing IAP header", async () => {
    const html = await renderLogin(IAP);
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("/auth/github");
    expect(html).toContain("Open CostKey through your sign-in");
    expect(html).toContain("Identity-Aware Proxy");
  });

  it("IAP mode signs in automatically when the request carried an identity", async () => {
    const html = await renderLogin({ ...IAP, iap: { ...IAP.iap!, status: "signed_in" } });
    expect(html).toContain("Signing you in");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Try again");
  });

  it("IAP mode explains a removed member and a misconfigured server", async () => {
    expect(await renderLogin({ ...IAP, iap: { ...IAP.iap!, status: "access_removed" } })).toContain("Access removed");
    expect(await renderLogin({ ...IAP, configured: false, iap: { ...IAP.iap!, status: "not_configured" } })).toContain("COSTKEY_IAP_AUDIENCE");
  });

  it("OIDC mode shows a single Continue with <name> button", async () => {
    const html = await renderLogin(OIDC);
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("/auth/github");
    expect(html.match(/Continue with/g)).toHaveLength(1);
    expect(html).toContain("Continue with <!-- -->Okta");
    expect(html).toContain('href="/auth/oidc/start"');
  });

  it("OIDC mode carries the CLI handoff and shows provider errors", async () => {
    const html = await renderLogin(OIDC, "/login?cli=1&error=oidc_domain");
    expect(html).toContain('href="/auth/oidc/start?returnTo=%2Fcli-auth"');
    expect(html).toContain("email domain");
  });
});

describe("sign-in helpers", () => {
  it("routes signed-in visitors to the CLI handoff or a safe return path", () => {
    expect(signedInDestination(new URLSearchParams("cli=1"))).toBe("/cli-auth");
    expect(signedInDestination(new URLSearchParams("returnTo=%2Fcosts%3Fx%3D1"))).toBe("/costs?x=1");
    expect(signedInDestination(new URLSearchParams("returnTo=%2F%2Fevil.example"))).toBe("/");
    expect(signedInDestination(new URLSearchParams("returnTo=https%3A%2F%2Fevil.example"))).toBe("/");
    expect(signedInDestination(new URLSearchParams("returnTo=%2Flogin"))).toBe("/");
  });

  it("builds the OIDC start link", () => {
    expect(oidcStartHref(OIDC, new URLSearchParams())).toBe("/auth/oidc/start");
    expect(oidcStartHref(OIDC, new URLSearchParams("returnTo=/traces"))).toBe("/auth/oidc/start?returnTo=%2Ftraces");
  });

  it("maps known error codes only", () => {
    expect(ssoErrorMessage("oidc_state")).toMatch(/expired/);
    expect(ssoErrorMessage("<script>")).toBeNull();
    expect(iapStatusMessage("invalid_assertion").title).toMatch(/verify/);
  });
});
