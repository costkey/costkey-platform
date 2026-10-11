import { test } from "node:test";
import assert from "node:assert/strict";
import { projectDsn, publicOrigin, secureCookies } from "../public-url.js";

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { run(); } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("DSNs and links point at this server", () => {
  withEnv({ PUBLIC_URL: undefined }, () => {
    assert.equal(projectDsn("ck_key", "proj_1"), "https://ck_key@app.costkey.dev/proj_1");
    assert.equal(publicOrigin(), "https://app.costkey.dev");
  });
  withEnv({ PUBLIC_URL: "http://192.168.1.20:4100/" }, () => {
    assert.equal(projectDsn("ck_key", "proj_1"), "http://ck_key@192.168.1.20:4100/proj_1");
    assert.equal(publicOrigin(), "http://192.168.1.20:4100");
  });
  withEnv({ PUBLIC_URL: "not a url" }, () => assert.equal(publicOrigin(), "https://app.costkey.dev"));
});

test("session cookies are Secure only when the console is served over HTTPS", () => {
  withEnv({ PUBLIC_URL: undefined, COSTKEY_COOKIE_SECURE: undefined, NODE_ENV: "production" }, () => assert.equal(secureCookies(), true));
  withEnv({ PUBLIC_URL: "https://costkey.example.com", COSTKEY_COOKIE_SECURE: undefined, NODE_ENV: "production" }, () => assert.equal(secureCookies(), true));
  withEnv({ PUBLIC_URL: "http://localhost:4100", COSTKEY_COOKIE_SECURE: undefined, NODE_ENV: "production" }, () => assert.equal(secureCookies(), false));
  withEnv({ PUBLIC_URL: "http://localhost:4100", COSTKEY_COOKIE_SECURE: "true", NODE_ENV: "production" }, () => assert.equal(secureCookies(), true));
});
