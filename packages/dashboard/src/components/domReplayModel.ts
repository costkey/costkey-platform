import type { TraceEvent } from "../api";
import { callFailure } from "./callOutcome";

/**
 * Browser replays (rrweb recordings from @costkey/replay), kept free of React.
 *
 * A recording plays in a sandboxed iframe with scripts off. Before it does,
 * every URL in it is rewritten: images and fonts we cached from the agent's
 * browser point at our own copy; anything else becomes a blank, so a replay
 * never loads from the original site (or, through a relative path, from ours).
 */

export interface RecordedAction {
  /** Milliseconds from the start of the recording. */
  at: number;
  name: string;
  selector?: string;
  url?: string;
  x?: number;
  y?: number;
  key?: string;
  textLength?: number;
}

export interface PreparedRecording {
  id: string;
  /** rrweb events ready for the player, starting at a full snapshot. */
  events: Array<{ type: number; timestamp: number; data?: unknown }>;
  startMs: number;
  endMs: number;
  /**
   * Just after the first full snapshot. The player applies events strictly
   * before the playhead when it seeks, so earlier seeks would show nothing new.
   */
  firstFrameAt: number;
  actions: RecordedAction[];
  /** URL of the first page shown. */
  firstUrl: string | null;
}

const FULL_SNAPSHOT = 2;
const META = 4;
const CUSTOM = 5;
const ACTION_TAG = "costkey.action";
const ASSET_TAG = "costkey.asset";
export const BLANK_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const BLANK = "data:,";

/** Attributes whose whole value is a URL, and what an uncached one becomes. */
const URL_ATTRIBUTES: Record<string, string> = {
  src: BLANK_IMAGE,
  poster: BLANK_IMAGE,
  background: BLANK_IMAGE,
  href: BLANK,
  "xlink:href": BLANK_IMAGE,
  action: BLANK,
  formaction: BLANK,
  ping: BLANK,
};

type AssetLookup = (url: string) => string | null;

function isSafeInline(url: string): boolean {
  return /^(data:|blob:|about:blank|#)/i.test(url.trim());
}

function rewriteUrl(url: string, lookup: AssetLookup, blank: string): string {
  const trimmed = url.trim();
  if (trimmed === "" || isSafeInline(trimmed)) return url;
  return lookup(trimmed) ?? blank;
}

function rewriteSrcset(value: string, lookup: AssetLookup): string {
  const kept = value
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const [url = "", ...descriptor] = candidate.split(/\s+/);
      const mapped = isSafeInline(url) ? url : lookup(url);
      return mapped ? [mapped, ...descriptor].join(" ") : null;
    })
    .filter((candidate): candidate is string => candidate !== null);
  return kept.length > 0 ? kept.join(", ") : BLANK_IMAGE;
}

/** CSS: `url(...)` to our copy or a blank, and no `@import` of anything. */
export function rewriteCss(css: string, lookup: AssetLookup): string {
  return css
    .replace(/@import\s+(?:url\()?\s*(['"]?)[^'")\s;]+\1\s*\)?[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote: string, url: string) => `url("${rewriteUrl(url, lookup, BLANK).replace(/"/g, "%22")}")`);
}

function rewriteValue(value: unknown, key: string, lookup: AssetLookup): unknown {
  if (typeof value === "string") {
    const lower = key.toLowerCase();
    if (lower === "srcset") return rewriteSrcset(value, lookup);
    if (lower in URL_ATTRIBUTES) return rewriteUrl(value, lookup, URL_ATTRIBUTES[lower]!);
    if (/url\(|@import/i.test(value)) return rewriteCss(value, lookup);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, key, lookup));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) out[childKey] = rewriteValue(child, childKey, lookup);
    return out;
  }
  return value;
}

/**
 * Turn one recording's raw events into something the player can show safely,
 * or null when it has no full snapshot to start from.
 */
export function prepareRecording(
  id: string,
  raw: unknown[],
  assetHref: (sha256: string) => string,
): PreparedRecording | null {
  const assets = new Map<string, string>();
  const actionEvents: Array<{ timestamp: number; payload: Record<string, unknown> }> = [];
  const page: Array<{ type: number; timestamp: number; data?: unknown }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const event = item as { type?: unknown; timestamp?: unknown; data?: { tag?: unknown; payload?: unknown } };
    if (typeof event.type !== "number" || typeof event.timestamp !== "number") continue;
    if (event.type === CUSTOM && event.data?.tag === ASSET_TAG) {
      const payload = event.data.payload as { url?: unknown; sha256?: unknown } | undefined;
      if (typeof payload?.url === "string" && typeof payload.sha256 === "string" && /^[0-9a-f]{64}$/.test(payload.sha256)) {
        assets.set(payload.url, assetHref(payload.sha256));
      }
      continue;
    }
    if (event.type === CUSTOM && event.data?.tag === ACTION_TAG) {
      if (event.data.payload && typeof event.data.payload === "object") actionEvents.push({ timestamp: event.timestamp, payload: event.data.payload as Record<string, unknown> });
      continue;
    }
    page.push(event as { type: number; timestamp: number; data?: unknown });
  }
  // Batches arrive in order, but keep the player's timeline strictly sorted (ties keep their order).
  page.sort((a, b) => a.timestamp - b.timestamp);
  const first = page.findIndex((event) => event.type === FULL_SNAPSHOT);
  if (first < 0) return null;
  const start = first > 0 && page[first - 1]!.type === META ? first - 1 : first;
  const lookup: AssetLookup = (url) => assets.get(url) ?? null;
  const events = page.slice(start).map((event) =>
    event.type === META ? event : { ...event, data: rewriteValue(event.data, "", lookup) },
  );
  const startMs = events[0]!.timestamp;
  const endMs = events[events.length - 1]!.timestamp;
  const meta = events.find((event) => event.type === META)?.data as { href?: unknown } | undefined;
  const actions = actionEvents
    .filter((action) => action.timestamp >= startMs - 2000 && action.timestamp <= endMs + 2000)
    .map(({ timestamp, payload }) => ({ ...cleanAction(payload), at: Math.max(0, timestamp - startMs) }))
    .filter((action): action is RecordedAction => action.name !== "");
  const snapshot = events.find((event) => event.type === FULL_SNAPSHOT)!;
  return {
    id,
    events,
    startMs,
    endMs: Math.max(endMs, startMs + 1),
    firstFrameAt: snapshot.timestamp - startMs + 1,
    actions,
    firstUrl: typeof meta?.href === "string" ? meta.href : null,
  };
}

function cleanAction(payload: Record<string, unknown>): Omit<RecordedAction, "at"> {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const action: Omit<RecordedAction, "at"> = { name: text(payload.name) ?? "" };
  const selector = text(payload.selector);
  const url = text(payload.url);
  const key = text(payload.key);
  const x = number(payload.x);
  const y = number(payload.y);
  const textLength = number(payload.textLength);
  if (selector) action.selector = selector;
  if (url) action.url = url;
  if (key) action.key = key;
  if (x !== undefined) action.x = x;
  if (y !== undefined) action.y = y;
  if (textLength !== undefined) action.textLength = textLength;
  return action;
}

/** "Clicked #buy", "Went to example.com/cart", "Typed 12 characters". */
export function describeAction(action: RecordedAction): string {
  const verb = action.name.split(".").pop() ?? action.name;
  const target = action.selector ?? (action.url ? shortUrl(action.url) : action.x != null && action.y != null ? `${Math.round(action.x)}, ${Math.round(action.y)}` : "");
  const label: Record<string, string> = {
    goto: "Went to", click: "Clicked", mouseClick: "Clicked", dblclick: "Double-clicked", tap: "Tapped", fill: "Filled", type: "Typed into",
    press: "Pressed", keyboardPress: "Pressed", keyboardType: "Typed", keyboardInsertText: "Typed", check: "Checked", uncheck: "Unchecked",
    selectOption: "Selected in", select: "Selected in", hover: "Hovered", focus: "Focused", screenshot: "Took a screenshot",
    reload: "Reloaded", goBack: "Went back", goForward: "Went forward", wheel: "Scrolled", mouseWheel: "Scrolled", setInputFiles: "Attached files to",
  };
  const words = label[verb] ?? verb;
  if ((verb === "press" || verb === "keyboardPress") && action.key) return `Pressed ${action.key}`;
  if (verb === "type" && !action.selector && action.textLength != null) return `Typed ${action.textLength} characters`;
  if (verb === "keyboardType" || verb === "keyboardInsertText") return action.textLength != null ? `Typed ${action.textLength} characters` : "Typed";
  return target ? `${words} ${target}` : words;
}

export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

export interface TimedCall {
  eventId: string;
  callNumber: number;
  /** Epoch milliseconds when the call started. */
  startMs: number;
  model: string;
  cost: number | null;
  failed: boolean;
  costSoFar: number;
}

/** The run's calls in time order, with what the run had cost by each (failed calls cost nothing). */
export function timedCalls(events: TraceEvent[]): TimedCall[] {
  let costSoFar = 0;
  return events
    .map((event, index) => ({ event, index, startMs: Date.parse(event.timestamp) }))
    .filter(({ startMs }) => Number.isFinite(startMs))
    .sort((a, b) => a.startMs - b.startMs || a.index - b.index)
    .map(({ event, startMs }, position) => {
      const failed = callFailure(event) !== null;
      const cost = failed ? 0 : event.cost_usd == null ? null : Number(event.cost_usd);
      if (cost != null && Number.isFinite(cost)) costSoFar += cost;
      return { eventId: event.id, callNumber: position + 1, startMs, model: event.model, cost, failed, costSoFar };
    });
}

/** The latest item at or before a moment, by binary search over a sorted list. */
export function latestAt<T>(items: T[], at: number, time: (item: T) => number): T | null {
  let low = 0;
  let high = items.length - 1;
  let found: T | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (time(items[mid]!) <= at) { found = items[mid]!; low = mid + 1; }
    else high = mid - 1;
  }
  return found;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
