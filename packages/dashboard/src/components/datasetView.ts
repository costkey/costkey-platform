/**
 * Small, React-free helpers shared by the Datasets and eval pages.
 */

export type LabelTone = "good" | "critical" | "neutral";

/** Good and Bad read as verdicts; anything else is a plain label. */
export function labelTone(label: string): LabelTone {
  if (/^(good|correct|pass(ed)?|ok)$/i.test(label.trim())) return "good";
  if (/^(bad|wrong|fail(ed)?)$/i.test(label.trim())) return "critical";
  return "neutral";
}

/** Labels by count, Good and Bad first when counts tie. */
export function labelEntries(labels: Record<string, number>): Array<{ label: string; count: number; tone: LabelTone }> {
  const order = (tone: LabelTone) => (tone === "good" ? 0 : tone === "critical" ? 1 : 2);
  return Object.entries(labels)
    .map(([label, count]) => ({ label, count: Number(count) || 0, tone: labelTone(label) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || order(a.tone) - order(b.tone) || a.label.localeCompare(b.label));
}

/** "3 min ago", "5 h ago", "2 days ago", then the date. */
export function timeAgo(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "";
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: new Date(at).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" }).format(at);
}

/** Share of scored cases that passed, or null when nothing was scored. */
export function passShare(passed: number, failed: number): number | null {
  const scored = passed + failed;
  return scored > 0 ? passed / scored : null;
}

export function percent(share: number | null): string {
  return share == null ? "—" : `${Math.round(share * 100)}%`;
}

/** The candidate's cost against the original calls': "74% cheaper", "2.1× the cost". */
export function costChange(candidate: number | null, original: number | null): { text: string; tone: "good" | "warn" | "neutral" } | null {
  if (candidate == null || original == null || original <= 0) return null;
  const ratio = candidate / original;
  if (Math.abs(ratio - 1) < 0.02) return { text: "Same cost", tone: "neutral" };
  if (ratio < 1) return { text: `${Math.round((1 - ratio) * 100)}% cheaper`, tone: "good" };
  return { text: ratio >= 2 ? `${ratio.toFixed(1)}× the cost` : `${Math.round((ratio - 1) * 100)}% more`, tone: "warn" };
}

/** "model: claude-haiku-4-5" pairs from an eval's configuration, short values only. */
export function configurationPairs(configuration: Record<string, unknown> | null | undefined, limit = 4): Array<{ key: string; value: string }> {
  if (!configuration) return [];
  return Object.entries(configuration)
    .map(([key, value]) => ({ key, value: typeof value === "string" ? value : JSON.stringify(value) }))
    .filter((pair) => pair.value !== undefined && pair.value.length <= 80)
    .slice(0, limit);
}

/** How a pass rate reads: good from 80%, a warning from 50%, critical below. */
export function shareTone(share: number | null): "good" | "warn" | "critical" | "neutral" {
  if (share == null) return "neutral";
  if (share >= 0.8) return "good";
  if (share >= 0.5) return "warn";
  return "critical";
}
