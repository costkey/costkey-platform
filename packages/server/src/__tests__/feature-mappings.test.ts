import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mappingMatches, parseFeatureMapping } from "../feature-mappings.js";

describe("feature mapping contract", () => {
  it("requires a target feature and at least one exact match dimension", () => {
    assert.deepEqual(parseFeatureMapping({ feature: "search", match: { provider: "openai", model: "gpt-*" } }), {
      feature: "search",
      match: { provider: "openai", model: "gpt-*" },
    });
    assert.ok("error" in parseFeatureMapping({ feature: "search", match: {} }));
  });

  it("matches provider/model/context patterns without inspecting bodies", () => {
    const match = { provider: "openai", model: "gpt-*", context: { environment: "prod" } };
    assert.equal(mappingMatches(match, {
      provider: "openai",
      model: "gpt-4o",
      context: { environment: "prod", prompt: "must not be searched" },
    }), true);
    assert.equal(mappingMatches(match, {
      provider: "anthropic",
      model: "claude-3",
      context: { environment: "prod" },
    }), false);
  });

  it("preserves an explicit feature as a caller-owned label", () => {
    assert.equal(mappingMatches({ provider: "openai" }, {
      provider: "openai",
      model: "gpt-4o",
      context: { feature: "caller-supplied" },
    }), true);
  });

  it("treats wildcard metacharacters as the mapping language, not regex input", () => {
    assert.equal(mappingMatches({ function: "search.*" }, { bl_function: "search.foo", context: {} }), true);
    assert.equal(mappingMatches({ function: "search.*" }, { bl_function: "searchXfoo", context: {} }), false);
    assert.equal(mappingMatches({ function: "search?" }, { bl_function: "search1", context: {} }), true);
    assert.equal(mappingMatches({ function: "search?" }, { bl_function: "search12", context: {} }), false);
  });
});
