import type { BoardBucketUnit } from "../api";

/** 534012 -> "534.0K", 1250000 -> "1.3M", 184 -> "184". */
export function compactNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const numeric = Number(value);
  const abs = Math.abs(numeric);
  if (abs >= 1e9) return `${(numeric / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(numeric / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(numeric / 1e3).toFixed(1)}K`;
  return Math.round(numeric).toLocaleString("en-US");
}

/** Quality scores on 0..1 read as two decimals. */
export function formatScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toFixed(2);
}

export type KpiDelta =
  | { kind: "none" }
  | { kind: "same" }
  | { kind: "change"; percent: number; rising: boolean; good: boolean };

/**
 * Change against the previous window of equal length. A missing or zero
 * previous value has nothing to compare with.
 */
export function kpiDelta(current: number | null | undefined, previous: number | null | undefined, higherIsBetter: boolean): KpiDelta {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return { kind: "none" };
  const percent = (current - previous) / Math.abs(previous) * 100;
  if (Math.abs(percent) < 0.05) return { kind: "same" };
  const rising = percent > 0;
  return { kind: "change", percent, rising, good: rising === higherIsBetter };
}

/** "+12.4%" / "-19.0%" */
export function signedPercent(percent: number): string {
  return `${percent > 0 ? "+" : "-"}${Math.abs(percent).toFixed(1)}%`;
}

/** The window of equal length that ends where this one starts (matches the server). */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const start = Date.parse(from);
  const length = Math.max(0, Date.parse(to) - start);
  return { from: new Date(start - length).toISOString(), to: new Date(start).toISOString() };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Bucket labels are local wall time ("2026-10-10T14:00"): "10 Oct" or "14:00". */
export function bucketLabel(bucket: string, unit: BoardBucketUnit, withDate = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(bucket);
  if (!match) return bucket;
  const day = `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? ""}`;
  if (unit === "day") return day;
  return withDate ? `${day} ${match[4]}:${match[5]}` : `${match[4]}:${match[5]}`;
}

/** Align a sparse series to the full bucket list, null where nothing happened. */
export function alignSeries<T extends { bucket: string }>(buckets: string[], points: T[], value: (point: T) => number | null): Array<number | null> {
  const byBucket = new Map(points.map((point) => [point.bucket, value(point)]));
  return buckets.map((bucket) => byBucket.get(bucket) ?? null);
}

/** Evenly spaced tick indexes, always including the first and last. */
export function tickIndexes(length: number, max = 5): number[] {
  if (length <= 0) return [];
  if (length <= max) return Array.from({ length }, (_, index) => index);
  // Even steps; the last tick moves to the end rather than crowding it.
  const step = Math.ceil((length - 1) / (max - 1));
  const ticks: number[] = [];
  for (let index = 0; index < length; index += step) ticks.push(index);
  const last = ticks[ticks.length - 1];
  if (last !== length - 1) {
    if (length - 1 - last <= step / 2) ticks[ticks.length - 1] = length - 1;
    else ticks.push(length - 1);
  }
  return ticks;
}

/** A round axis ceiling whose half is also round: 0.87 -> 1, 3400 -> 4000. */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const nice = [1, 2, 3, 4, 5, 6, 8, 10].find((step) => fraction <= step) ?? 10;
  return nice * exponent;
}
