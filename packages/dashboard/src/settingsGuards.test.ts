import { describe, expect, it } from "vitest";
import { arrayOrEmpty, SettingsApiError } from "./settingsApi";
import { isValidFxBasis, parseFindingThresholdForm } from "./settingsGuards";

describe("Settings API compatibility guards", () => {
  it("renders an empty collection when an additive field is omitted", () => {
    expect(arrayOrEmpty<unknown>(undefined)).toEqual([]);
    expect(arrayOrEmpty<unknown>(null)).toEqual([]);
    expect(arrayOrEmpty<unknown>({})).toEqual([]);
  });

  it("keeps valid collections and typed API errors intact", () => {
    const providers = [{ id: "provider_1" }];
    expect(arrayOrEmpty(providers)).toBe(providers);
    const error = new SettingsApiError("Not configured", 404, { code: "unconfigured" });
    expect(error.status).toBe(404);
    expect(error.body).toEqual({ code: "unconfigured" });
  });

  it("requires a positive dated INR basis with a source", () => {
    expect(isValidFxBasis("83.25", "RBI reference", "2026-09-13")).toBe(true);
    expect(isValidFxBasis("0", "RBI reference", "2026-09-13")).toBe(false);
    expect(isValidFxBasis("83.25", "", "2026-09-13")).toBe(false);
    expect(isValidFxBasis("83.25", "RBI reference", "not-a-date")).toBe(false);
  });

  it("parses bounded finding thresholds and converts relative percentages", () => {
    expect(parseFindingThresholdForm({
      expensiveSample: "20",
      expensiveMultiplier: "3",
      expensiveMinAbsolute: "0.05",
      unitSample: "20",
      unitMinRelativePercent: "50",
      unitMinImpact: "1",
    })).toEqual({
      expensiveSample: 20,
      expensiveMultiplier: 3,
      expensiveMinAbsolute: 0.05,
      unitSample: 20,
      unitMinRelative: 0.5,
      unitMinImpact: 1,
    });
    expect(parseFindingThresholdForm({
      expensiveSample: "0",
      expensiveMultiplier: "3",
      expensiveMinAbsolute: "0.05",
      unitSample: "20",
      unitMinRelativePercent: "50",
      unitMinImpact: "1",
    })).toBeNull();
    expect(parseFindingThresholdForm({
      expensiveSample: "20",
      expensiveMultiplier: "3",
      expensiveMinAbsolute: "0.05",
      unitSample: "20",
      unitMinRelativePercent: "101",
      unitMinImpact: "1",
    })).toBeNull();
  });
});
