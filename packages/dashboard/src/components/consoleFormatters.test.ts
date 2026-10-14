import { afterEach, describe, expect, it, vi } from "vitest";
import { formatReportedAmount, parsePeriod, periodDates, periodLabel, relativeMs, reportingCurrencyNote, sourceAttributionStatus } from "./consoleFormatters";

describe("periodDates", () => {
  afterEach(() => vi.useRealTimers());

  it("starts month-to-date at workspace midnight in Asia/Kolkata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));

    expect(periodDates("mtd", "Asia/Kolkata")).toEqual({
      from: "2026-08-31T18:30:00.000Z",
      to: "2026-09-13T12:00:00.000Z",
    });
  });

  it("starts month-to-date at the correct DST-aware workspace midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));

    expect(periodDates("mtd", "America/Los_Angeles").from).toBe("2026-09-01T07:00:00.000Z");
  });
});

describe("reported money", () => {
  it("converts canonical USD with the saved workspace basis", () => {
    expect(formatReportedAmount(12.5, "INR", { available: true, rate: 83, source: "workspace", asOf: "2026-09-13" })).toBe("₹1,037.50");
  });

  it("keeps the USD source visible when the conversion is unavailable", () => {
    expect(formatReportedAmount(12.5, "INR", { available: false, rate: null, source: null, asOf: null })).toBe("$12.50");
    expect(reportingCurrencyNote("INR", { available: false, rate: null, source: null, asOf: null })).toBe("USD source · INR conversion unavailable");
  });

  it("distinguishes attribution provenance from a recorded source location", () => {
    expect(sourceAttributionStatus({ featureSource: "explicit" })).toBe("Explicit");
    expect(sourceAttributionStatus({ featureMappingId: "mapping_1", functionName: "run" })).toBe("Mapped");
    expect(sourceAttributionStatus({ featureSource: "inferred", functionName: "run" })).toBe("Inferred");
    expect(sourceAttributionStatus({ functionName: "run" })).toBe("Recorded location");
    expect(sourceAttributionStatus(null)).toBe("Unavailable");
  });
});

describe("time ranges", () => {
  it("reads any rolling window, today, the month, the last deploy and custom", () => {
    expect(parsePeriod("15m")).toBe("15m");
    expect(parsePeriod("3h")).toBe("3h");
    expect(parsePeriod("2w")).toBe("2w");
    expect(parsePeriod("deploy")).toBe("deploy");
    expect(parsePeriod("today")).toBe("today");
    expect(parsePeriod("0h")).toBe("mtd");
    expect(parsePeriod("9999d")).toBe("mtd");
    expect(parsePeriod("nonsense")).toBe("mtd");
  });

  it("words a period the way the picker shows it", () => {
    expect(periodLabel("1h")).toBe("last hour");
    expect(periodLabel("45m")).toBe("last 45 minutes");
    expect(periodLabel("deploy")).toBe("since the last deploy");
  });

  it("ends rolling windows now and keeps 7 and 30 days on local midnight", () => {
    const { from, to } = periodDates("15m", "UTC");
    expect(Date.parse(to) - Date.parse(from)).toBe(15 * 60_000);
    expect(relativeMs("3h")).toBe(3 * 3_600_000);
    expect(relativeMs("today")).toBeNull();
    expect(periodDates("7d", "UTC").from.endsWith("T00:00:00.000Z")).toBe(true);
  });
});
