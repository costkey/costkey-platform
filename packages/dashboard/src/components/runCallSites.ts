import type { TraceEvent } from "../api";
import { isNoCharge } from "./callOutcome";
import { shortenPath } from "./stackFrames";

/** One place in the app's code that made model calls during a run. */
export interface RunCallSite {
  key: string;
  functionName: string | null;
  file: string | null;
  line: number | null;
  provider: string;
  model: string | null;
  calls: number;
  /** Known cost; null when any of its calls is unpriced and none is priced. */
  cost: number | null;
  unpriced: number;
  /** The call to select when the row is clicked: the most expensive one. */
  firstCallId: string;
}

/** Where a run's money was spent in code, most expensive first. Calls with no recorded location are left out. */
export function runCallSites(events: TraceEvent[]): RunCallSite[] {
  const sites = new Map<string, RunCallSite & { topCost: number }>();
  for (const event of events) {
    const functionName = event.bl_function?.trim() || null;
    const file = event.bl_file?.trim() || null;
    if (!functionName && !file) continue;
    const line = event.bl_line == null ? null : Number(event.bl_line);
    const key = [functionName, file, line, event.provider, event.model].join("\u0000");
    const cost = event.cost_usd == null ? null : Number(event.cost_usd);
    const site = sites.get(key) ?? { key, functionName, file, line, provider: event.provider, model: event.model || null, calls: 0, cost: null, unpriced: 0, firstCallId: event.id, topCost: -1 };
    site.calls += 1;
    if (cost != null && Number.isFinite(cost)) {
      site.cost = (site.cost ?? 0) + cost;
      if (cost > site.topCost) { site.topCost = cost; site.firstCallId = event.id; }
    } else if (!isNoCharge(event)) {
      site.unpriced += 1;
    }
    sites.set(key, site);
  }
  return [...sites.values()]
    .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.calls - a.calls || a.key.localeCompare(b.key))
    .map(({ topCost: _topCost, ...site }) => site);
}

/** "src/search.ts:47", or just the file. */
export function siteLocation(site: Pick<RunCallSite, "file" | "line">): string | null {
  if (!site.file) return null;
  const file = shortenPath(site.file).short;
  return site.line != null && Number.isFinite(site.line) ? `${file}:${site.line}` : file;
}

/** The run's feature and release, from its summary or the first call that carries one. */
export function runLabel(summary: Record<string, unknown>, events: TraceEvent[], key: "feature" | "release"): string | null {
  const direct = summary[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const event of events) {
    const own = (event as unknown as Record<string, unknown>)[key];
    if (typeof own === "string" && own.trim()) return own.trim();
    let context: unknown = event.context;
    if (typeof context === "string") { try { context = JSON.parse(context); } catch { context = null; } }
    const value = context && typeof context === "object" ? (context as Record<string, unknown>)[key] : null;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
