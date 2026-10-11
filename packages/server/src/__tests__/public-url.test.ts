import { test } from "node:test";
import assert from "node:assert/strict";
import { appPath, basePath, cookiePath, projectDsn, publicAppUrl, publicOrigin, secureCookies } from "../public-url.js";

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { run(); } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("DSNs and links point at this server", () => {
  withEnv({ PUBLIC_URL: undefined, PORT: undefined }, () => {
    assert.equal(projectDsn("ck_key", "proj_1"), "http://ck_key@localhost:4100/proj_1", "unset means this machine");
    assert.equal(publicOrigin(), "http://localhost:4100");
  });
  withEnv({ PUBLIC_URL: undefined, PORT: "8080" }, () => assert.equal(publicOrigin(), "http://localhost:8080"));
  withEnv({ PUBLIC_URL: "http://192.168.1.20:4100/" }, () => {
    assert.equal(projectDsn("ck_key", "proj_1"), "http://ck_key@192.168.1.20:4100/proj_1");
    assert.equal(publicOrigin(), "http://192.168.1.20:4100");
  });
  withEnv({ PUBLIC_URL: "not a url", PORT: undefined }, () => assert.equal(publicOrigin(), "http://localhost:4100"));
});

test("on Render, Railway and Fly.io the platform's address is used", () => {
  const none = { PUBLIC_URL: undefined, RENDER_EXTERNAL_URL: undefined, RAILWAY_PUBLIC_DOMAIN: undefined, FLY_APP_NAME: undefined };
  withEnv({ ...none, RENDER_EXTERNAL_URL: "https://costkey-ab12.onrender.com" }, () => {
    assert.equal(projectDsn("ck_key", "proj_1"), "https://ck_key@costkey-ab12.onrender.com/proj_1");
    assert.equal(secureCookies(), true);
  });
  withEnv({ ...none, RAILWAY_PUBLIC_DOMAIN: "costkey-production.up.railway.app" }, () => assert.equal(publicOrigin(), "https://costkey-production.up.railway.app"));
  withEnv({ ...none, FLY_APP_NAME: "acme-costkey" }, () => assert.equal(publicOrigin(), "https://acme-costkey.fly.dev"));
  withEnv({ ...none, FLY_APP_NAME: "acme-costkey", PUBLIC_URL: "https://costkey.acme.com" }, () => assert.equal(publicOrigin(), "https://costkey.acme.com", "PUBLIC_URL wins"));
});

test("session cookies are Secure only when the console is served over HTTPS", () => {
  withEnv({ PUBLIC_URL: undefined, COSTKEY_COOKIE_SECURE: undefined, NODE_ENV: "production" }, () => assert.equal(secureCookies(), false, "a local install is plain http"));
  withEnv({ PUBLIC_URL: "https://costkey.example.com", COSTKEY_COOKIE_SECURE: undefined, NODE_ENV: "production" }, () => assert.equal(secureCookies(), true));
  withEnv({ PUBLIC_URL: "http://localhost:4100", COSTKEY_COOKIE_SECURE: undefined, NODE_ENV: "production" }, () => assert.equal(secureCookies(), false));
  withEnv({ PUBLIC_URL: "http://localhost:4100", COSTKEY_COOKIE_SECURE: "true", NODE_ENV: "production" }, () => assert.equal(secureCookies(), true));
});

test("the base path is PUBLIC_URL's path, or COSTKEY_BASE_PATH", () => {
  const none = { PUBLIC_URL: undefined, COSTKEY_BASE_PATH: undefined, RENDER_EXTERNAL_URL: undefined, RAILWAY_PUBLIC_DOMAIN: undefined, FLY_APP_NAME: undefined, PORT: undefined };
  withEnv(none, () => {
    assert.equal(basePath(), "", "unset means the root");
    assert.equal(cookiePath(), "/");
    assert.equal(appPath("/login"), "/login");
  });
  withEnv({ ...none, PUBLIC_URL: "https://costkey.example.com" }, () => assert.equal(basePath(), ""));
  withEnv({ ...none, PUBLIC_URL: "https://costkey.example.com/" }, () => assert.equal(basePath(), ""));
  withEnv({ ...none, PUBLIC_URL: "https://portal.example.com/costkey" }, () => {
    assert.equal(basePath(), "/costkey");
    assert.equal(cookiePath(), "/costkey");
    assert.equal(appPath("/login?error=github_state"), "/costkey/login?error=github_state");
    assert.equal(appPath("/"), "/costkey/");
    assert.equal(publicOrigin(), "https://portal.example.com", "the origin has no path");
    assert.equal(publicAppUrl(), "https://portal.example.com/costkey");
  });
  withEnv({ ...none, PUBLIC_URL: "https://portal.example.com/costkey/" }, () => assert.equal(basePath(), "/costkey", "trailing slash removed"));
  withEnv({ ...none, PUBLIC_URL: "https://x.example.com/tools/costkey//" }, () => assert.equal(basePath(), "/tools/costkey"));
  withEnv({ ...none, PUBLIC_URL: "https://x.example.com/costkey", COSTKEY_BASE_PATH: "/ck" }, () => {
    assert.equal(basePath(), "/ck", "COSTKEY_BASE_PATH wins");
    assert.equal(publicAppUrl(), "https://x.example.com/ck");
  });
  withEnv({ ...none, PUBLIC_URL: "https://x.example.com/costkey", COSTKEY_BASE_PATH: "/" }, () => assert.equal(basePath(), "", "an explicit root"));
  withEnv({ ...none, COSTKEY_BASE_PATH: "costkey/" }, () => assert.equal(basePath(), "/costkey", "a leading slash is added"));
  withEnv({ ...none, COSTKEY_BASE_PATH: "//evil.example.com/x" }, () => assert.equal(basePath(), "/evil.example.com/x", "never a host"));
  withEnv({ ...none, COSTKEY_BASE_PATH: '/a"b<c>' }, () => assert.equal(basePath(), "/a%22b%3Cc%3E", "unsafe characters are encoded"));
});

test("DSNs include the base path", () => {
  const none = { PUBLIC_URL: undefined, COSTKEY_BASE_PATH: undefined };
  withEnv({ ...none, PUBLIC_URL: "https://portal.example.com/costkey" }, () => {
    assert.equal(projectDsn("ck_key", "proj_1"), "https://ck_key@portal.example.com/costkey/proj_1");
  });
  withEnv({ ...none, PUBLIC_URL: "http://localhost:4300/costkey/" }, () => {
    assert.equal(projectDsn("ck_key", "proj_1"), "http://ck_key@localhost:4300/costkey/proj_1");
  });
  withEnv({ ...none, PUBLIC_URL: "http://localhost:4301" }, () => {
    assert.equal(projectDsn("ck_key", "proj_1"), "http://ck_key@localhost:4301/proj_1", "no base path at the root");
  });
});
