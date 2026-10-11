import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWithBase(base: string | undefined, location = { pathname: "/", search: "", protocol: "https:", host: "portal.example.com" }) {
  vi.resetModules();
  vi.stubGlobal("window", { __COSTKEY_BASE__: base, location });
  return import("./basePath");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("base path", () => {
  it("leaves URLs unchanged at the root", async () => {
    const { BASE_PATH, appUrl, routerPath, projectDsn } = await loadWithBase(undefined);
    expect(BASE_PATH).toBe("");
    expect(appUrl("/api/v1/projects")).toBe("/api/v1/projects");
    expect(routerPath("/traces/abc")).toBe("/traces/abc");
    expect(projectDsn("ck_key", "proj_1")).toBe("https://ck_key@portal.example.com/proj_1");
  });

  it("puts every absolute URL under the injected base path", async () => {
    const { BASE_PATH, appUrl, routerPath, currentRouterPath, projectDsn } = await loadWithBase("/costkey/", {
      pathname: "/costkey/traces/abc", search: "?project=p1", protocol: "https:", host: "portal.example.com",
    });
    expect(BASE_PATH).toBe("/costkey");
    expect(appUrl("/api/v1/projects")).toBe("/costkey/api/v1/projects");
    expect(appUrl("/providers/openai.svg")).toBe("/costkey/providers/openai.svg");
    expect(routerPath("/costkey")).toBe("/");
    expect(routerPath("/costkey/settings")).toBe("/settings");
    expect(routerPath("/costkeyish")).toBe("/costkeyish");
    expect(currentRouterPath()).toBe("/traces/abc?project=p1");
    expect(projectDsn("ck_key", "proj_1")).toBe("https://ck_key@portal.example.com/costkey/proj_1");
  });
});
