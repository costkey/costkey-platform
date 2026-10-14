import { kpiDelta } from "./overviewBoardModel";

/** What a period is compared with: the same window moved back, or the deploy before this one. */
export type CompareTo = "off" | "previous" | "day" | "week" | "deploy";

const HOUR_MS = 60 * 60 * 1000;

export const COMPARE_OPTIONS: Array<{ value: CompareTo; label: string }> = [
  { value: "off", label: "Compare" },
  { value: "previous", label: "vs previous period" },
  { value: "day", label: "vs day before" },
  { value: "week", label: "vs week before" },
  { value: "deploy", label: "vs previous deploy" },
];

export function parseCompare(value: string | null | undefined): CompareTo {
  return value === "previous" || value === "day" || value === "week" || value === "deploy" ? value : "off";
}

/** "the day before", for "−24% vs the day before". */
export function compareText(compare: CompareTo): string {
  return compare === "day" ? "the day before" : compare === "week" ? "the week before" : compare === "deploy" ? "the previous deploy" : "the previous period";
}

/**
 * The window to compare with: the same length, moved back a day, a week, or
 * its own length. Equal lengths keep totals like calls and spend comparable.
 */
export function compareRange(range: { from: string; to: string }, compare: CompareTo): { from: string; to: string } | null {
  // A deploy's window is its own lifetime, not this one moved back.
  if (compare === "off" || compare === "deploy") return null;
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null;
  const shift = compare === "day" ? 24 * HOUR_MS : compare === "week" ? 7 * 24 * HOUR_MS : to - from;
  return { from: new Date(from - shift).toISOString(), to: new Date(to - shift).toISOString() };
}

export interface MetricChange {
  /** "24%" or "1.2 pts"; empty when there is nothing to compare. */
  text: string;
  direction: "up" | "down" | "same" | "none";
  tone: "good" | "bad" | "flat";
}

const NONE: MetricChange = { text: "", direction: "none", tone: "flat" };

/**
 * How `current` moved from `previous`. Rates (0..1) move in percentage points,
 * everything else as a percent. `better` says which way is good; null for
 * plain volume. From zero there is no percent, so the change is "new".
 */
export function metricChange(current: number | null | undefined, previous: number | null | undefined, better: "lower" | "higher" | null, rate = false): MetricChange {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) return NONE;
  const toneFor = (rising: boolean): MetricChange["tone"] => better == null ? "flat" : rising === (better === "higher") ? "good" : "bad";
  if (rate) {
    const points = (current - previous) * 100;
    if (Math.abs(points) < 0.05) return { text: "", direction: "same", tone: "flat" };
    return { text: `${Math.abs(points).toFixed(Math.abs(points) < 10 ? 1 : 0)} pts`, direction: points > 0 ? "up" : "down", tone: toneFor(points > 0) };
  }
  if (previous === 0) return current > 0 ? { text: "new", direction: "up", tone: toneFor(true) } : { text: "", direction: "same", tone: "flat" };
  const delta = kpiDelta(current, previous, true);
  if (delta.kind === "none") return NONE;
  if (delta.kind === "same") return { text: "", direction: "same", tone: "flat" };
  const percent = Math.abs(delta.percent);
  return { text: `${percent >= 100 ? Math.round(percent).toLocaleString("en-US") : percent.toFixed(percent < 10 ? 1 : 0)}%`, direction: delta.rising ? "up" : "down", tone: toneFor(delta.rising) };
}

/**
 * For "vs previous deploy": the newest release live in the period, and the
 * one to compare it with (the chosen `base`, or the release before it).
 */
export function deployPair<T extends { release: string; firstSeen: string; lastSeen: string }>(releases: T[], range: { from: string; to: string }, base?: string | null): { current: T; base: T } | null {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const index = releases.findIndex((item) => Date.parse(item.lastSeen) >= from && Date.parse(item.firstSeen) <= to);
  if (index < 0) return null;
  const current = releases[index]!;
  const chosen = base ? releases.find((item) => item.release === base && item.release !== current.release) : undefined;
  const previous = chosen ?? releases[index + 1];
  return previous ? { current, base: previous } : null;
}

/** A deploy's own window: from its first call to its last, at most 30 days back from the last. */
export function releaseWindow(release: { firstSeen: string; lastSeen: string }): { from: string; to: string } {
  const last = Date.parse(release.lastSeen) + 1000;
  const first = Math.max(Date.parse(release.firstSeen), last - 30 * 24 * 60 * 60 * 1000);
  return { from: new Date(first).toISOString(), to: new Date(last).toISOString() };
}
