import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

beforeAll(() => {
  const history = {
    state: null,
    length: 1,
    pushState: () => {},
    replaceState: () => {},
    go: () => {},
    back: () => {},
    forward: () => {},
  };
  const location = { pathname: "/", search: "", hash: "", href: "http://localhost/", origin: "http://localhost" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { history, location, addEventListener: () => {}, removeEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }), localStorage: { getItem: () => null, setItem: () => {} } } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { defaultView: globalThis.window, documentElement: { dataset: {} } } });
});

describe("dashboard boot", () => {
  it("imports and renders the app shell before auth resolves", async () => {
    const { default: App } = await import("./App");
    const markup = renderToString(createElement(App));
    expect(markup).toContain("Loading navigation");
  });
});
