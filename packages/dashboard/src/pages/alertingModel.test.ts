import { describe, expect, it } from "vitest";
import {
  destinationAddress,
  draftReady,
  eventLabel,
  isSlackWebhookUrl,
  thresholdFromPercent,
  timezoneOptions,
  withPreferenceDefaults,
} from "./alertingModel";
import type { NotificationPreferences } from "../settingsApi";

const slack = "https://hooks.slack.com/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx";

const base: NotificationPreferences = {
  id: "pref",
  projectId: null,
  weeklySummaryEnabled: false,
  weeklySummaryHour: 9,
  weeklySummaryWeekday: 1,
  timezone: "UTC",
  findingsEnabled: false,
  policyWarningThresholds: [0.8, 1],
  enforcementEnabled: true,
  executionReceiptsEnabled: false,
  updatedAt: null,
};

describe("alerting model", () => {
  it("accepts only Slack incoming webhooks", () => {
    expect(isSlackWebhookUrl(slack)).toBe(true);
    expect(isSlackWebhookUrl(`${slack}?x=1`)).toBe(false);
    expect(isSlackWebhookUrl("https://hooks.slack.com.evil.test/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx")).toBe(false);
    expect(isSlackWebhookUrl("http://hooks.slack.com/services/T00TESTWS/B00TESTCH/abcdefghijklmnopqrstuvwx")).toBe(false);
  });

  it("gates the add button per channel", () => {
    expect(draftReady({ kind: "email", address: "me@example.com", secret: "", projectId: "" })).toBe(true);
    expect(draftReady({ kind: "email", address: "nope", secret: "", projectId: "" })).toBe(false);
    expect(draftReady({ kind: "slack", address: slack, secret: "", projectId: "" })).toBe(true);
    expect(draftReady({ kind: "slack", address: "https://example.com/hook", secret: "", projectId: "" })).toBe(false);
    expect(draftReady({ kind: "webhook", address: "https://example.com/hook", secret: "short", projectId: "" })).toBe(false);
    expect(draftReady({ kind: "webhook", address: "https://example.com/hook", secret: "0123456789abcdef", projectId: "" })).toBe(true);
  });

  it("fills daily and budget defaults for older servers", () => {
    const filled = withPreferenceDefaults(base);
    expect(filled.dailySummaryEnabled).toBe(false);
    expect(filled.dailySummaryHour).toBe(9);
    expect(filled.budgetAlertsEnabled).toBe(true);
    expect(withPreferenceDefaults({ ...base, enforcementEnabled: false }).budgetAlertsEnabled).toBe(false);
    expect(withPreferenceDefaults({ ...base, dailySummaryEnabled: true, dailySummaryHour: 7, budgetAlertsEnabled: false }).dailySummaryHour).toBe(7);
  });

  it("labels events, addresses and thresholds tersely", () => {
    expect(eventLabel("daily_summary")).toBe("Daily summary");
    expect(eventLabel("policy_warning")).toBe("Budget alert");
    expect(eventLabel("custom_thing")).toBe("custom thing");
    expect(destinationAddress({ kind: "webhook", address: "https://hooks.example.com/costkey?x=1" })).toBe("hooks.example.com");
    expect(destinationAddress({ kind: "slack", address: "hooks.slack.com/services/T1/B1/••••wxyz" })).toBe("hooks.slack.com/services/T1/B1/••••wxyz");
    expect(thresholdFromPercent("80")).toBe(0.8);
    expect(thresholdFromPercent("250")).toBe(1);
    expect(thresholdFromPercent("x")).toBeNull();
    expect(timezoneOptions("Asia/Kolkata", "UTC")[0]).toBe("Asia/Kolkata");
    expect(new Set(timezoneOptions("UTC", "UTC")).size).toBe(timezoneOptions("UTC", "UTC").length);
  });
});
