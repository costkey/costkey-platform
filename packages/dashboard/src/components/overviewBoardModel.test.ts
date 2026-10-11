import { describe, expect, it } from "vitest";
import { alignSeries, bucketLabel, compactNumber, formatScore, kpiDelta, niceCeiling, previousRange, signedPercent, tickIndexes } from "./overviewBoardModel";

describe("overview board model", () => {
  it("formats compact numbers and scores", () => {
    expect(compactNumber(534_012)).toBe("534.0K");
    expect(compactNumber(1_250_000)).toBe("1.3M");
    expect(compactNumber(184)).toBe("184");
    expect(compactNumber(null)).toBe("—");
    expect(formatScore(0.8567)).toBe("0.86");
  });

  it("compares with the previous window and says when there is nothing to compare", () => {
    expect(kpiDelta(149, 184, true)).toEqual({ kind: "change", percent: (149 - 184) / 184 * 100, rising: false, good: false });
    expect(signedPercent((149 - 184) / 184 * 100)).toBe("-19.0%");
    expect(kpiDelta(12, 10, false)).toMatchObject({ rising: true, good: false });
    expect(kpiDelta(5, 0, true)).toEqual({ kind: "none" });
    expect(kpiDelta(5, null, true)).toEqual({ kind: "none" });
    expect(kpiDelta(10, 10, true)).toEqual({ kind: "same" });
  });

  it("uses the window of equal length before the current one", () => {
    expect(previousRange("2026-10-08T00:00:00.000Z", "2026-10-11T00:00:00.000Z")).toEqual({ from: "2026-10-05T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z" });
  });

  it("labels buckets and aligns sparse series", () => {
    expect(bucketLabel("2026-10-10T00:00", "day")).toBe("10 Oct");
    expect(bucketLabel("2026-10-10T14:00", "hour")).toBe("14:00");
    expect(bucketLabel("2026-10-10T14:00", "hour", true)).toBe("10 Oct 14:00");
    expect(alignSeries(["a", "b", "c"], [{ bucket: "c", v: 2 }], (point) => point.v)).toEqual([null, null, 2]);
    expect(tickIndexes(31, 5)).toEqual([0, 8, 16, 24, 30]);
    expect(tickIndexes(8, 5)).toEqual([0, 2, 4, 7]);
    expect(tickIndexes(25, 5)).toEqual([0, 6, 12, 18, 24]);
    expect(tickIndexes(3, 5)).toEqual([0, 1, 2]);
    expect(niceCeiling(0.87)).toBe(1);
    expect(niceCeiling(3400)).toBe(4000);
  });
});
