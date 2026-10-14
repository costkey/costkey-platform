import { describe, expect, it } from "vitest";
import { comparedPeriods, metricChange, pairModels, parsePreset, rangeText, sameLength, zonedDay } from "./components/periodCompare";

describe("compared periods", () => {
  const now = new Date("2026-10-14T08:30:00Z"); // 14:00 in Kolkata

  it("compares today so far with the whole of yesterday, in the workspace time zone", () => {
    const periods = comparedPeriods("today", now, "Asia/Kolkata");
    expect(periods).toEqual({
      a: { from: "2026-10-12T18:30:00.000Z", to: "2026-10-13T18:30:00.000Z" },
      b: { from: "2026-10-13T18:30:00.000Z", to: "2026-10-14T08:30:00.000Z" },
      aLabel: "Yesterday",
      bLabel: "Today",
    });
  });

  it("puts rolling windows back to back", () => {
    const periods = comparedPeriods("24h", now, "UTC")!;
    expect(periods.b).toEqual({ from: "2026-10-13T08:30:00.000Z", to: "2026-10-14T08:30:00.000Z" });
    expect(periods.a).toEqual({ from: "2026-10-12T08:30:00.000Z", to: "2026-10-13T08:30:00.000Z" });
    expect(sameLength(periods.a, periods.b)).toBe(true);
  });

  it("reads custom days as whole days, and a day in progress ends now", () => {
    const periods = comparedPeriods("custom", now, "UTC", { aFrom: "2026-10-06", aTo: "2026-10-07", bFrom: "2026-10-13", bTo: "2026-10-14" })!;
    expect(periods.a).toEqual({ from: "2026-10-06T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z" });
    expect(periods.b).toEqual({ from: "2026-10-13T00:00:00.000Z", to: "2026-10-14T08:30:00.000Z" });
    expect(sameLength(periods.a, periods.b)).toBe(false);
  });

  it("refuses custom days that end before they start or lie in the future", () => {
    expect(comparedPeriods("custom", now, "UTC", { aFrom: "2026-10-07", aTo: "2026-10-06", bFrom: "2026-10-13", bTo: "2026-10-13" })).toBeNull();
    expect(comparedPeriods("custom", now, "UTC", { aFrom: "2026-10-13", aTo: "2026-10-13", bFrom: "2026-10-20", bTo: "2026-10-21" })).toBeNull();
    expect(comparedPeriods("custom", now, "UTC", { aFrom: "", aTo: "2026-10-13", bFrom: "2026-10-13", bTo: "2026-10-13" })).toBeNull();
  });

  it("knows its presets and days", () => {
    expect(parsePreset("7d")).toBe("7d");
    expect(parsePreset("nonsense")).toBe("today");
    expect(zonedDay(new Date("2026-10-13T20:00:00Z"), "Asia/Kolkata")).toBe("2026-10-14");
    expect(zonedDay(new Date("2026-10-01T05:00:00Z"), "UTC", -1)).toBe("2026-09-30");
  });

  it("writes ranges in the workspace time zone and says now for an open window", () => {
    expect(rangeText({ from: "2026-10-13T18:30:00.000Z", to: "2026-10-14T08:30:00.000Z" }, now, "Asia/Kolkata")).toBe("14 Oct, 00:00 – now");
    expect(rangeText({ from: "2026-10-12T18:30:00.000Z", to: "2026-10-13T18:30:00.000Z" }, now, "Asia/Kolkata")).toBe("13 Oct, 00:00 – 14 Oct, 00:00");
  });
});

describe("metric change", () => {
  it("judges latency lower-is-better as a percent", () => {
    expect(metricChange(1000, 1200, "lower")).toEqual({ text: "+20.0%", tone: "bad" });
    expect(metricChange(1000, 800, "lower")).toEqual({ text: "-20.0%", tone: "good" });
  });

  it("moves rates in percentage points", () => {
    expect(metricChange(0.02, 0.05, "lower", true)).toEqual({ text: "+3.0 pts", tone: "bad" });
    expect(metricChange(0.05, 0.05, "lower", true)).toEqual({ text: "Same", tone: "flat" });
  });

  it("leaves volume uncoloured and missing values blank", () => {
    expect(metricChange(10, 15, null)).toEqual({ text: "+50.0%", tone: "flat" });
    expect(metricChange(null, 15, "lower")).toEqual({ text: "", tone: "flat" });
    expect(metricChange(0, 15, "lower")).toEqual({ text: "", tone: "flat" });
    expect(metricChange(0, 3, "lower", false, String)).toEqual({ text: "+3", tone: "bad" });
  });
});

describe("model pairs", () => {
  it("joins both periods' models, busiest now first", () => {
    const pairs = pairModels(
      [{ provider: "openai", model: "gpt-5", calls: 40 }, { provider: "anthropic", model: "claude-haiku-5-5", calls: 5 }],
      [{ provider: "openai", model: "gpt-5", calls: 10 }, { provider: "anthropic", model: "claude-sonnet-5-5", calls: 30 }],
    );
    expect(pairs.map((pair) => [pair.model, pair.a?.calls ?? null, pair.b?.calls ?? null])).toEqual([
      ["claude-sonnet-5-5", null, 30],
      ["gpt-5", 40, 10],
      ["claude-haiku-5-5", 5, null],
    ]);
  });
});
