import type {
  NotificationDelivery,
  NotificationDestination,
  NotificationDestinationKind,
  NotificationPreferences,
} from "../settingsApi";

/** Mirrors the server check; the server remains the authority. */
const SLACK_WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{2,32}\/B[A-Z0-9]{2,32}\/[A-Za-z0-9]{16,64}$/;

export function isSlackWebhookUrl(value: string): boolean {
  return SLACK_WEBHOOK_PATTERN.test(value.trim());
}

export const EVENT_LABELS: Record<string, string> = {
  weekly_summary: "Weekly summary",
  daily_summary: "Daily summary",
  policy_warning: "Budget alert",
  enforcement: "Refused call",
  finding: "Flagged change",
  execution_receipt: "Batch summary",
};

export function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType.replace(/_/g, " ");
}

export const CHANNEL_LABELS: Record<NotificationDestinationKind, string> = {
  email: "Email",
  slack: "Slack",
  webhook: "Webhook",
};

export function channelLabel(kind: string): string {
  return CHANNEL_LABELS[kind as NotificationDestinationKind] ?? kind;
}

/** What the table shows for a destination; never more than the server returned. */
export function destinationAddress(destination: Pick<NotificationDestination, "kind" | "address">): string {
  if (destination.kind === "webhook") {
    try {
      return new URL(destination.address).host;
    } catch {
      return "Signed endpoint";
    }
  }
  return destination.address;
}

export interface DestinationDraft {
  kind: NotificationDestinationKind;
  address: string;
  secret: string;
  projectId: string;
}

export function draftReady(draft: DestinationDraft): boolean {
  const address = draft.address.trim();
  if (!address) return false;
  if (draft.kind === "slack") return isSlackWebhookUrl(address);
  if (draft.kind === "webhook") return draft.secret.length >= 16 && /^https?:\/\//.test(address);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

export const DEFAULT_HOUR = 9;

/** Fill fields an older server may omit so the page renders the same either way. */
export function withPreferenceDefaults(preferences: NotificationPreferences): Required<Pick<NotificationPreferences, "dailySummaryEnabled" | "dailySummaryHour" | "budgetAlertsEnabled">> & NotificationPreferences {
  return {
    ...preferences,
    dailySummaryEnabled: preferences.dailySummaryEnabled === true,
    dailySummaryHour: Number.isInteger(preferences.dailySummaryHour) ? Number(preferences.dailySummaryHour) : DEFAULT_HOUR,
    budgetAlertsEnabled: typeof preferences.budgetAlertsEnabled === "boolean" ? preferences.budgetAlertsEnabled : preferences.enforcementEnabled !== false,
  };
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function timezoneOptions(current: string | null | undefined, browser: string): string[] {
  const options = [browser, "UTC", "Asia/Kolkata", "Europe/London", "America/New_York", "America/Los_Angeles"];
  if (current) options.unshift(current);
  return [...new Set(options.filter(Boolean))];
}

/** Clamp a percent input to a stored ratio between 1% and 100%. */
export function thresholdFromPercent(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.min(100, Math.round(parsed))) / 100;
}

export function deliveryTone(status: NotificationDelivery["status"]): "good" | "warn" | "critical" | "neutral" {
  if (status === "sent") return "good";
  if (status === "failed") return "critical";
  if (status === "suppressed") return "warn";
  return "neutral";
}

export function deliveryStatusLabel(status: NotificationDelivery["status"]): string {
  if (status === "sent") return "Sent";
  if (status === "failed") return "Failed";
  if (status === "suppressed") return "Skipped";
  if (status === "pending") return "Queued";
  return status;
}
