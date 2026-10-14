import { describe, expect, it } from "vitest";
import { compareRange, compareText, deployPair, metricChange, parseCompare, releaseWindow } from "./components/compareScope";

describe("compare range", () => {
  const today = { from: "2026-10-13T18:30:00.000Z", to: "2026-10-14T08:30:00.000Z" };

  it("moves the same window back a day or a week, so today so far meets yesterday to the same hour", () => {
    expect(compareRange(today, "day")).toEqual({ from: "2026-10-12T18:30:00.000Z", to: "2026-10-13T08:30:00.000Z" });
    expect(compareRange(today, "week")).toEqual({ from: "2026-10-06T18:30:00.000Z", to: "2026-10-07T08:30:00.000Z" });
  });

  it("puts the previous period right before this one", () => {
    expect(compareRange({ from: "2026-10-07T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z" }, "previous"))
      .toEqual({ from: "2026-09-30T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z" });
  });

  it("compares with nothing when off or when the window is broken", () => {
    expect(compareRange(today, "off")).toBeNull();
    expect(compareRange({ from: today.to, to: today.from }, "day")).toBeNull();
  });

  it("reads the URL and words the comparison", () => {
    expect(parseCompare("week")).toBe("week");
    expect(parseCompare("yes")).toBe("off");
    expect(compareText("day")).toBe("the day before");
  });
});

describe("metric change", () => {
  it("judges latency lower-is-better", () => {
    expect(metricChange(1200, 1000, "lower")).toEqual({ text: "20%", direction: "up", tone: "bad" });
    expect(metricChange(800, 1000, "lower")).toEqual({ text: "20%", direction: "down", tone: "good" });
    expect(metricChange(1046, 1000, "lower")).toEqual({ text: "4.6%", direction: "up", tone: "bad" });
  });

  it("moves rates in percentage points", () => {
    expect(metricChange(0.189, 0, "lower", true)).toEqual({ text: "19 pts", direction: "up", tone: "bad" });
    expect(metricChange(0.05, 0.02, "lower", true)).toEqual({ text: "3.0 pts", direction: "up", tone: "bad" });
    expect(metricChange(0.05, 0.05, "lower", true).direction).toBe("same");
  });

  it("calls a change from zero new, leaves volume uncoloured and missing values blank", () => {
    expect(metricChange(10, 0, "lower")).toEqual({ text: "new", direction: "up", tone: "bad" });
    expect(metricChange(15, 10, null)).toEqual({ text: "50%", direction: "up", tone: "flat" });
    expect(metricChange(15, null, "lower").direction).toBe("none");
    expect(metricChange(3_000, 100, null).text).toBe("2,900%");
  });
});

describe("deploys", () => {
  const releases = [
    { release: "c3", firstSeen: "2026-10-14T06:00:00.000Z", lastSeen: "2026-10-14T08:00:00.000Z" },
    { release: "b2", firstSeen: "2026-10-12T00:00:00.000Z", lastSeen: "2026-10-14T06:00:00.000Z" },
    { release: "a1", firstSeen: "2026-09-01T00:00:00.000Z", lastSeen: "2026-10-12T00:00:00.000Z" },
  ];

  it("compares the newest deploy in the period with the one before it, or the chosen one", () => {
    const today = { from: "2026-10-13T18:30:00.000Z", to: "2026-10-14T08:30:00.000Z" };
    expect(deployPair(releases, today)).toEqual({ current: releases[0], base: releases[1] });
    expect(deployPair(releases, today, "a1")).toEqual({ current: releases[0], base: releases[2] });
    // The oldest deploy has nothing before it.
    expect(deployPair(releases, { from: "2026-10-01T00:00:00.000Z", to: "2026-10-05T00:00:00.000Z" })).toBeNull();
  });

  it("has nothing to compare with only one deploy, and a deploy's window is its lifetime up to 30 days", () => {
    expect(deployPair([releases[0]!], { from: "2026-10-14T00:00:00.000Z", to: "2026-10-14T09:00:00.000Z" })).toBeNull();
    expect(releaseWindow(releases[2]!)).toEqual({ from: "2026-09-12T00:00:01.000Z", to: "2026-10-12T00:00:01.000Z" });
    expect(compareRange({ from: "2026-10-13T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z" }, "deploy")).toBeNull();
  });
});
