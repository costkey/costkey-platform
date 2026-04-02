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

/** Format cost always as $X.XX */
export function formatCost(cost: number): string {
  if (cost >= 1000) return `$${(cost / 1000).toFixed(1)}k`;
  return `$${cost.toFixed(2)}`;
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
