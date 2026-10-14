import { describe, expect, it } from "vitest";
import { budgetLineValue, chartRange, daysInKeyMonth, spendKeyLabel, zonedMidnight } from "./spendSeriesModel";

describe("spend over time", () => {
  it("spreads a monthly budget over the days of each month", () => {
    expect(daysInKeyMonth("2026-02-10")).toBe(28);
    expect(budgetLineValue("2026-02-10", "day", 280, "calendar_month")).toBe(10);
    expect(budgetLineValue("2026-10", "month", 280, "calendar_month")).toBe(280);
    expect(budgetLineValue("2026-10", "month", 10, "calendar_day")).toBe(310);
    expect(budgetLineValue("2026-10-01", "day", 10, "calendar_day")).toBe(10);
    expect(budgetLineValue("2026-10-01", "day", 10, "per_trace")).toBeNull();
  });

  it("finds midnight in the workspace time zone", () => {
    expect(zonedMidnight(2026, 10, 1, "Asia/Kolkata").toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(zonedMidnight(2026, 10, 1, "UTC").toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("widens a short period to six months in the month view", () => {
    const range = { from: "2026-09-30T18:30:00.000Z", to: "2026-10-12T10:00:00.000Z" };
    expect(chartRange(range, "day", "Asia/Kolkata")).toEqual({ ...range, widened: false });
    expect(chartRange(range, "month", "Asia/Kolkata")).toEqual({ from: "2026-04-30T18:30:00.000Z", to: range.to, widened: true });
    const year = { from: "2025-10-12T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" };
    expect(chartRange(year, "month", "UTC")).toEqual({ ...year, widened: false });
  });

  it("labels days and months without shifting them", () => {
    expect(spendKeyLabel("2026-10-04", "day")).toBe("4 Oct");
    expect(spendKeyLabel("2026-10", "month")).toBe("Oct");
    expect(spendKeyLabel("2026-10", "month", true)).toBe("Oct 2026");
    expect(spendKeyLabel("2026-09-30", "day", true)).toBe("30 Sep 2026");
  });
});
