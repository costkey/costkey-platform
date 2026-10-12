import { describe, expect, it } from "vitest";
import { attributeRows, valueText } from "./spanAttributes";

describe("attributeRows", () => {
  it("lists a nested object's fields instead of [object Object]", () => {
    expect(attributeRows({ framework: "openai_agents", openai_agents: { model: "gpt-6-luna", tools: ["search", "plan"] } })).toEqual([
      ["framework", "openai_agents"],
      ["model", "gpt-6-luna"],
      ["tools", "search, plan"],
    ]);
  });

  it("keeps the parent's name when two fields would share a label", () => {
    expect(attributeRows({ model: "a", openai_agents: { model: "b" } })).toEqual([["model", "a"], ["openai_agents.model", "b"]]);
  });

  it("prints structured content as JSON", () => {
    expect(valueText([{ ok: true }])).toBe('[\n  {\n    "ok": true\n  }\n]');
    expect(valueText(null)).toBe("—");
  });
});
