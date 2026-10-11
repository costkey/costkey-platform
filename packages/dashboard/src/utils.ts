/** Format duration in seconds ("3.7 s") per the prototype; minutes only past an hour-scale */
/** Durations of zero mean "not recorded" (real calls always take time), so they read as a dash. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Format token counts with commas and k/M suffixes */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  return tokens.toLocaleString();
}

/**
 * Format cost with enough precision to be meaningful and consistent:
 * amounts under $1 always carry four decimals ("$0.0158") so a column of
 * per-run costs lines up; larger amounts use cents ("$248.60", "$12,400.00").
 */
export function formatCost(cost: number | null | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return "Unpriced";
  if (cost > 0 && cost < 0.0001) return "<$0.0001";
  if (cost === 0) return "$0.00";
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
export function findBusinessFrame(frames: FrameLike[]): FrameLike | null {
  const infraPatterns = ["node_modules/", "site-packages/", ".next/", "dist/", "node:", "internal/"];
  const isInfra = (f: { fileName?: string | null }) =>
    infraPatterns.some((p) => (f.fileName ?? "").includes(p));

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
