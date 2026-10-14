import { dateInputToIso, zonedDateParts } from "./consoleFormatters";
import { kpiDelta, signedPercent } from "./overviewBoardModel";

export type ComparePreset = "today" | "24h" | "7d" | "custom";

export interface TimeRange { from: string; to: string }

/** Two windows side by side: A is the earlier one, B the one being judged against it. */
export interface ComparedPeriods { a: TimeRange; b: TimeRange; aLabel: string; bLabel: string }

/** Custom days as the URL carries them: inclusive YYYY-MM-DD bounds per period. */
export interface CustomDays { aFrom: string; aTo: string; bFrom: string; bTo: string }

const HOUR_MS = 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parsePreset(value: string | null | undefined): ComparePreset {
  return value === "24h" || value === "7d" || value === "custom" ? value : "today";
}

/** YYYY-MM-DD of a moment in the workspace time zone, shifted by whole days. */
export function zonedDay(date: Date, timeZone?: string | null, shiftDays = 0): string {
  const { year, month, day } = zonedDateParts(date, timeZone);
  return new Date(Date.UTC(year, month - 1, day + shiftDays)).toISOString().slice(0, 10);
}

/** The default custom days: yesterday against today. */
export function defaultCustomDays(now: Date, timeZone?: string | null): CustomDays {
  const yesterday = zonedDay(now, timeZone, -1);
  const today = zonedDay(now, timeZone);
  return { aFrom: yesterday, aTo: yesterday, bFrom: today, bTo: today };
}

function dayRange(from: string, to: string, timeZone?: string | null): TimeRange | null {
  if (!DAY_PATTERN.test(from) || !DAY_PATTERN.test(to)) return null;
  const start = dateInputToIso(from, timeZone ?? undefined);
  const end = dateInputToIso(to, timeZone ?? undefined, true);
  if (!start || !end || Date.parse(start) >= Date.parse(end)) return null;
  return { from: start, to: end };
}

/** Days are whole days in the workspace time zone; "today" runs up to now. */
export function comparedPeriods(preset: ComparePreset, now: Date, timeZone?: string | null, custom?: CustomDays): ComparedPeriods | null {
  const end = now.toISOString();
  if (preset === "today") {
    const today = dateInputToIso(zonedDay(now, timeZone), timeZone ?? undefined) ?? end;
    const yesterday = dateInputToIso(zonedDay(now, timeZone, -1), timeZone ?? undefined) ?? end;
    return { a: { from: yesterday, to: today }, b: { from: today, to: end }, aLabel: "Yesterday", bLabel: "Today" };
  }
  if (preset === "24h" || preset === "7d") {
    const length = preset === "24h" ? 24 * HOUR_MS : 7 * 24 * HOUR_MS;
    const start = now.getTime() - length;
    return {
      a: { from: new Date(start - length).toISOString(), to: new Date(start).toISOString() },
      b: { from: new Date(start).toISOString(), to: end },
      aLabel: preset === "24h" ? "Previous 24 hours" : "Previous 7 days",
      bLabel: preset === "24h" ? "Last 24 hours" : "Last 7 days",
    };
  }
  const days = custom ?? defaultCustomDays(now, timeZone);
  const a = dayRange(days.aFrom, days.aTo, timeZone);
  const b = dayRange(days.bFrom, days.bTo, timeZone);
  if (!a || !b) return null;
  // A day still in progress ends now, not at midnight.
  if (Date.parse(b.to) > now.getTime()) b.to = end;
  if (Date.parse(a.to) > now.getTime()) a.to = end;
  if (Date.parse(a.from) >= Date.parse(a.to) || Date.parse(b.from) >= Date.parse(b.to)) return null;
  return { a, b, aLabel: "Period A", bLabel: "Period B" };
}

/** Totals (calls, cost) only compare across windows of the same length. */
export function sameLength(a: TimeRange, b: TimeRange): boolean {
  const lengthA = Date.parse(a.to) - Date.parse(a.from);
  const lengthB = Date.parse(b.to) - Date.parse(b.from);
  const longest = Math.max(lengthA, lengthB);
  return longest > 0 && Math.abs(lengthA - lengthB) / longest < 0.01;
}

export interface MetricChange {
  /** "+12.4%", "-0.8 pts", "Same", or "" when there is nothing to compare. */
  text: string;
  tone: "good" | "bad" | "flat";
}

/**
 * How B moved from A. Rates (0..1) move in percentage points; everything else
 * as a percent of A. `better` says which way is good; null for plain volume.
 */
export function metricChange(a: number | null | undefined, b: number | null | undefined, better: "lower" | "higher" | null, rate = false, format?: (value: number) => string): MetricChange {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return { text: "", tone: "flat" };
  // From nothing there is no percent: say how much appeared.
  if (!rate && a === 0 && b > 0 && format) return { text: `+${format(b)}`, tone: better == null ? "flat" : better === "higher" ? "good" : "bad" };
  if (rate) {
    const points = (b - a) * 100;
    if (Math.abs(points) < 0.05) return { text: "Same", tone: "flat" };
    const rising = points > 0;
    return { text: `${rising ? "+" : "-"}${Math.abs(points).toFixed(1)} pts`, tone: better == null ? "flat" : rising === (better === "higher") ? "good" : "bad" };
  }
  const delta = kpiDelta(b, a, better !== "lower");
  if (delta.kind === "none") return { text: "", tone: "flat" };
  if (delta.kind === "same") return { text: "Same", tone: "flat" };
  return { text: signedPercent(delta.percent), tone: better == null ? "flat" : delta.good ? "good" : "bad" };
}

/** "13 Oct, 00:00 – 14 Oct, 00:00" in the workspace time zone; "now" for a window still open. */
export function rangeText(range: TimeRange, now: Date, timeZone?: string | null): string {
  const format = (iso: string) => {
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone: timeZone ?? undefined, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
    } catch {
      return iso.slice(0, 16).replace("T", " ");
    }
  };
  const open = Math.abs(Date.parse(range.to) - now.getTime()) < 60_000;
  return `${format(range.from)} – ${open ? "now" : format(range.to)}`;
}

export interface ModelPair<T> { provider: string; model: string; a: T | null; b: T | null }

/** Models from both periods, busiest in B first. */
export function pairModels<T extends { provider: string; model: string; calls: number }>(a: T[], b: T[], limit = 15): ModelPair<T>[] {
  const pairs = new Map<string, ModelPair<T>>();
  const key = (row: T) => `${row.provider}\u0001${row.model}`;
  for (const row of a) pairs.set(key(row), { provider: row.provider, model: row.model, a: row, b: null });
  for (const row of b) {
    const existing = pairs.get(key(row));
    if (existing) existing.b = row;
    else pairs.set(key(row), { provider: row.provider, model: row.model, a: null, b: row });
  }
  return [...pairs.values()]
    .sort((x, y) => (y.b?.calls ?? 0) - (x.b?.calls ?? 0) || (y.a?.calls ?? 0) - (x.a?.calls ?? 0) || x.model.localeCompare(y.model))
    .slice(0, limit);
}
