import { describe, expect, it } from "vitest";
import { configurationPairs, costChange, labelEntries, labelTone, passShare, percent, timeAgo } from "./datasetView";

describe("dataset view helpers", () => {
  it("reads Good and Bad as verdicts", () => {
    expect([labelTone("Good"), labelTone(" bad "), labelTone("wrong"), labelTone("needs review")]).toEqual(["good", "critical", "critical", "neutral"]);
    expect(labelEntries({ Bad: 1, Good: 1, "needs review": 3, empty: 0 }).map((entry) => entry.label)).toEqual(["needs review", "Good", "Bad"]);
  });

  it("says how long ago, then the date", () => {
    const now = Date.UTC(2026, 10, 10, 12, 0, 0);
    expect(timeAgo(new Date(now - 10_000).toISOString(), now)).toBe("just now");
    expect(timeAgo(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 min ago");
    expect(timeAgo(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3 h ago");
    expect(timeAgo(new Date(now - 26 * 3_600_000).toISOString(), now)).toBe("1 day ago");
    expect(timeAgo("2026-10-01T00:00:00Z", now)).toBe("1 Oct");
    expect(timeAgo(null, now)).toBe("");
  });

  it("compares pass rates and cost", () => {
    expect(passShare(1, 1)).toBe(0.5);
    expect(passShare(0, 0)).toBeNull();
    expect(percent(passShare(2, 1))).toBe("67%");
    expect(percent(null)).toBe("—");
    expect(costChange(0.0106, 0.0402)).toEqual({ text: "74% cheaper", tone: "good" });
    expect(costChange(0.09, 0.04)).toEqual({ text: "2.3× the cost", tone: "warn" });
    expect(costChange(0.05, 0.04)).toEqual({ text: "25% more", tone: "warn" });
    expect(costChange(null, 0.04)).toBeNull();
  });

  it("keeps short configuration values", () => {
    expect(configurationPairs({ model: "claude-haiku-4-5", temperature: 0, prompt: "x".repeat(200) })).toEqual([
      { key: "model", value: "claude-haiku-4-5" },
      { key: "temperature", value: "0" },
    ]);
  });
});
