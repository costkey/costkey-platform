import { afterEach, describe, expect, it } from "vitest";
import { agentHref, featureHref, modelHref, scopeSearch, userHref } from "./links";

function at(search: string) {
  Object.defineProperty(globalThis, "window", { value: { location: { search } }, configurable: true });
}

describe("drill-down links", () => {
  afterEach(() => at(""));

  it("keep the period and environment, and drop page-specific state", () => {
    at("?period=7d&environment=production&run=abc&call=x");
    expect(scopeSearch()).toBe("?period=7d&environment=production");
    expect(agentHref("research-agent")).toBe("/agents/research-agent?period=7d&environment=production");
  });

  it("encode names, models with slashes, users and features", () => {
    at("");
    expect(modelHref("openrouter", "google/gemini-2.5-flash")).toBe("/models/openrouter/google/gemini-2.5-flash");
    expect(userHref("3f2a/9c")).toBe("/users/3f2a%2F9c");
    expect(featureHref("generated-media-tts")).toBe("/costs?groupBy=feature&groupValue=generated-media-tts");
  });
});
