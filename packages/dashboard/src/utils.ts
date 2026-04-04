/** Format duration: >1s shows seconds, otherwise ms with commas */
export function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms).toLocaleString()}ms`;
}

/** Format token counts with commas and k/M suffixes */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  return tokens.toLocaleString();
}

/** Format cost — show enough precision to be meaningful */
export function formatCost(cost: number): string {
  if (cost >= 1000) return `$${(cost / 1000).toFixed(1)}k`;
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}

/** Strip date suffixes from model names */
export function truncateModel(model: string | null): string {
  if (!model) return "unknown";
  return model.replace(/-\d{4}[-\d]*/g, "").replace(/-$/, "");
}

/** Relative time ago */
export function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Truncate file path to last 2 segments */
export function truncateFile(path: string | null): string {
  if (!path) return "unknown";
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return ".../" + parts.slice(-2).join("/");
}

interface FrameLike {
  functionName?: string | null;
  fileName?: string | null;
  lineNumber?: number | null;
}

/**
 * Find the business logic frame from in-app frames.
 *
 * Codebases layer: entry point → business logic → wrapper → SDK.
 * - 1 frame  → use it
 * - 2 frames → use outermost
 * - 3+ frames → use second-to-last (skip generic entry point)
 */
const WRAPPER_FN_NAMES = new Set(["retry", "withretry", "withbackoff", "callwithretry", "withretries", "ratelimit", "ratelimitcheck", "withratelimit", "withcache", "cached", "memoized", "wrapasync", "wrapfn", "decorator"]);

function isWrapperFn(f: FrameLike): boolean {
  const fn = (f.functionName ?? "").split("\n")[0].trim().toLowerCase();
  return WRAPPER_FN_NAMES.has(fn);
}

export function findBusinessFrame(frames: FrameLike[]): FrameLike | null {
  if (!frames || frames.length === 0) return null;

  const useless = new Set(["<module>", "<anonymous>", "anonymous", "main", "_run", ""]);
  const meaningful = frames.filter((f) => {
    const fn = (f.functionName ?? "").split("\n")[0].trim();
    return fn && !useless.has(fn);
  });

  const pool = meaningful.length > 0 ? meaningful : frames;
  if (pool.length <= 1) return pool[0];

  // First frame from a different file that's NOT infrastructure
  const innerFile = pool[0].fileName ?? "";
  for (let i = 1; i < pool.length; i++) {
    const file = pool[i].fileName ?? "";
    if (file && file !== innerFile && !isInfra(pool[i])) return pool[i];
  }
  // Fallback: first different file (even if infra)
  for (let i = 1; i < pool.length; i++) {
    const file = pool[i].fileName ?? "";
    if (file && file !== innerFile) return pool[i];
  }
  // Same file — use frame[1]
  return pool.length >= 2 ? pool[1] : pool[0];
}

/** Parse call_site_frames from an event (handles string or array) */
export function parseFrames(raw: unknown): FrameLike[] {
  if (!raw) return [];
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return raw as FrameLike[];
}

/** Get clean function name (strip newlines from Python traceback format) */
export function cleanFunctionName(fn: string | null | undefined): string | null {
  if (!fn) return null;
  return fn.split("\n")[0].trim() || null;
}
