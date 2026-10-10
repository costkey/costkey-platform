import { describe, expect, it } from "vitest";
import { errorTone, formatDuration, formatRate, formatScore, qualityPath, reliabilityRows, trendPoints, type QualityReliabilityResponse, type QualityScore } from "./qualityView";

const stats = { calls: 10, p50DurationMs: 800, p95DurationMs: 2_400, p95TtftMs: null, streams: 0, errors: 1, errorRate: 0.1, retries: 2, retryRate: 0.2, cost: 1, wastedCost: 0.2 };

describe("quality view", () => {
  it("builds scoped API paths", () => {
    expect(qualityPath("p 1", "scores", { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z", environment: "all" }))
      .toBe("/api/v1/projects/p%201/quality/scores?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-02T00%3A00%3A00.000Z");
    expect(qualityPath("p", "reliability", { from: "a", to: "b", environment: "prod" })).toContain("environment=prod");
  });

  it("formats scores, durations and rates", () => {
    expect(formatScore(0.8234)).toBe("0.82");
    expect(formatScore(42.25)).toBe("42.3");
    expect(formatScore(null)).toBe("—");
    expect(formatDuration(820)).toBe("820 ms");
    expect(formatDuration(1_430)).toBe("1.4 s");
    expect(formatDuration(72_000)).toBe("72 s");
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(0.0004)).toBe("<0.1%");
    expect(formatRate(0.045)).toBe("4.5%");
    expect(formatRate(0.126)).toBe("13%");
    expect(formatRate(null)).toBe("—");
    expect(errorTone(0)).toBe("neutral");
    expect(errorTone(0.01)).toBe("warn");
    expect(errorTone(0.2)).toBe("critical");
  });

  it("switches reliability rows between model and agent", () => {
    const data: QualityReliabilityResponse = {
      from: "a", to: "b", totals: stats,
      byModel: [{ ...stats, provider: "openai", model: "gpt-4o" }],
      byAgent: [{ ...stats, agent: "support", runs: 3, failedRuns: 1 }],
    };
    expect(reliabilityRows(data, "model")[0]).toMatchObject({ name: "gpt-4o", secondary: "openai" });
    expect(reliabilityRows(data, "agent")[0]).toMatchObject({ name: "support", secondary: "3 runs" });
    expect(reliabilityRows(null, "model")).toEqual([]);
  });

  it("skips empty trend days instead of zeroing them", () => {
    const score = { trend: [{ day: "2026-10-01", avg: 0.5, count: 2 }, { day: "2026-10-02", avg: null, count: 0 }, { day: "2026-10-03", avg: 0.7, count: 1 }] } as QualityScore;
    expect(trendPoints(score).map((point) => point.day)).toEqual(["2026-10-01", "2026-10-03"]);
  });
});
