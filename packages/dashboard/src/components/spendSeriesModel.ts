import type { BudgetWindow } from "../budgetsApi";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days in the calendar month of a "2026-10-04" or "2026-10" key. */
export function daysInKeyMonth(key: string): number {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The budget a bar is measured against: a monthly limit spread evenly over
 * its days in the day view, or a daily limit added up in the month view.
 */
export function budgetLineValue(key: string, bucket: "day" | "month", limit: number, window: BudgetWindow): number | null {
  if (window === "calendar_month") return bucket === "month" ? limit : limit / daysInKeyMonth(key);
  if (window === "calendar_day") return bucket === "day" ? limit : limit * daysInKeyMonth(key);
  return null;
}

/** Month view needs a longer range than a month to say anything. */
export const LONG_RANGE_DAYS = 62;
export const MONTHS_SHOWN = 6;

function zonedParts(at: Date, timezone?: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** UTC instant of local midnight on a calendar date in the time zone. */
export function zonedMidnight(year: number, month: number, day: number, timezone?: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  const local = zonedParts(new Date(guess), timezone);
  const offset = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - guess;
  return new Date(guess - offset);
}

/**
 * The range a chart shows: the selected period by day, or by month. A short
 * period by month widens to the last six months so the bars compare.
 */
export function chartRange(range: { from: string; to: string }, bucket: "day" | "month", timezone?: string): { from: string; to: string; widened: boolean } {
  if (bucket === "day") return { ...range, widened: false };
  const spanDays = (new Date(range.to).getTime() - new Date(range.from).getTime()) / DAY_MS;
  if (spanDays > LONG_RANGE_DAYS) return { ...range, widened: false };
  const end = zonedParts(new Date(new Date(range.to).getTime() - 1), timezone);
  const startMonth = new Date(Date.UTC(end.year, end.month - 1 - (MONTHS_SHOWN - 1), 1));
  return { from: zonedMidnight(startMonth.getUTCFullYear(), startMonth.getUTCMonth() + 1, 1, timezone).toISOString(), to: range.to, widened: true };
}

/** "4 Oct" for a day key, "Oct" (or "Oct 2026" when asked) for a month key. */
export function spendKeyLabel(key: string, bucket: "day" | "month", withYear = false): string {
  const date = new Date(`${bucket === "month" ? `${key}-01` : key}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  return bucket === "month"
    ? date.toLocaleDateString("en-GB", { month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" })
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}
