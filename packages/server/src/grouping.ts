/**
 * Call chain grouping engine.
 *
 * Groups call sites into "features" by analyzing stack traces
 * and finding shared ancestor functions.
 *
 * Algorithm:
 * 1. Parse all call site stack traces
 * 2. Build a tree of function calls (parent → children)
 * 3. Find root ancestors that have multiple AI-calling descendants
 * 4. Each root ancestor = one "feature" with its descendant call sites
 *
 * No directory heuristics. No config. Pure stack trace analysis.
 */

interface CallSiteRow {
  call_site_key: string;
  file_name: string | null;
  function_name: string | null;
  line_number: number | null;
  total_calls: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_duration_ms: number;
  avg_ttft: number | null;
  avg_tps: number | null;
}

interface EventFrames {
  call_site_key: string;
  frames: StackFrame[];
}

interface StackFrame {
  fileName: string | null;
  functionName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
}

export interface Feature {
  /** The root ancestor function that ties all call sites together */
  rootFunction: string;
  rootFile: string | null;
  rootLine: number | null;
  /** All leaf AI call sites under this feature */
  callSites: CallSiteRow[];
  /** Aggregated stats */
  totalCost: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgDuration: number;
  /** The full call chains (root → ... → leaf) for visualization */
  chains: CallChain[];
}

export interface CallChain {
  /** Frames from root to leaf */
  frames: { functionName: string; fileName: string | null; lineNumber: number | null }[];
  /** The leaf call site key */
  callSiteKey: string;
}

/**
 * Group call sites into features by analyzing stack traces.
 */
export function groupIntoFeatures(
  callSiteStats: CallSiteRow[],
  eventFrames: EventFrames[],
): Feature[] {
  // Step 1: For each call site, collect all unique stack traces seen
  const callSiteTraces = new Map<string, StackFrame[][]>();
  for (const ef of eventFrames) {
    if (ef.frames.length === 0) continue;
    const existing = callSiteTraces.get(ef.call_site_key) ?? [];
    // Deduplicate by stringifying
    const key = ef.frames.map((f) => `${f.functionName}@${f.fileName}:${f.lineNumber}`).join("|");
    const alreadyHas = existing.some(
      (trace) => trace.map((f) => `${f.functionName}@${f.fileName}:${f.lineNumber}`).join("|") === key,
    );
    if (!alreadyHas) existing.push(ef.frames);
    callSiteTraces.set(ef.call_site_key, existing);
  }

  // Step 2: Build a map of call_site_key → best (longest) stack trace
  const bestTrace = new Map<string, StackFrame[]>();
  for (const [key, traces] of callSiteTraces) {
    // Pick the longest trace (most context)
    const longest = traces.reduce((a, b) => (a.length >= b.length ? a : b), []);
    bestTrace.set(key, longest);
  }

  // Step 3: Find root ancestors and group
  // A "root" is the deepest frame in the stack (last element = entry point)
  // Group call sites that share the same root function
  const rootGroups = new Map<string, { root: StackFrame; callSiteKeys: Set<string>; chains: CallChain[] }>();

  for (const [callSiteKey, trace] of bestTrace) {
    if (trace.length === 0) continue;

    // The root is the last frame (entry point / top of call chain)
    const rootFrame = trace[trace.length - 1];
    // Group by function+file, ignoring line number — same function at different
    // call sites (e.g., line 12 vs line 15) is still the same feature root
    const rootKey = `${rootFrame.functionName}@${rootFrame.fileName}`;

    const group = rootGroups.get(rootKey) ?? {
      root: rootFrame,
      callSiteKeys: new Set(),
      chains: [],
    };

    group.callSiteKeys.add(callSiteKey);
    group.chains.push({
      frames: trace.map((f) => ({
        functionName: f.functionName ?? "anonymous",
        fileName: f.fileName,
        lineNumber: f.lineNumber,
      })),
      callSiteKey,
    });

    rootGroups.set(rootKey, group);
  }

  // Step 4: Build Feature objects with aggregated stats
  // We group by root ancestor directly — all call sites that share
  // the same entry point function are one "feature".
  const features: Feature[] = [];

  for (const group of rootGroups.values()) {
    const callSites: CallSiteRow[] = [];
    let totalCost = 0;
    let totalCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let durationSum = 0;
    let durationCount = 0;

    // Aggregate across all call site keys (which may have multiple model entries)
    const seenKeys = new Set<string>();
    for (const key of group.callSiteKeys) {
      // Find all call_site_stats rows for this key (there may be multiple per model)
      const matchingStats = callSiteStats.filter((cs) => cs.call_site_key === key);
      for (const cs of matchingStats) {
        if (!seenKeys.has(`${cs.call_site_key}:${cs.function_name}`)) {
          callSites.push(cs);
        }
        seenKeys.add(`${cs.call_site_key}:${cs.function_name}`);
        totalCost += cs.total_cost_usd;
        totalCalls += cs.total_calls;
        totalInputTokens += cs.total_input_tokens;
        totalOutputTokens += cs.total_output_tokens;
        durationSum += cs.avg_duration_ms * cs.total_calls;
        durationCount += cs.total_calls;
      }
    }

    // Deduplicate call sites by function name for display
    const uniqueCallSites = deduplicateCallSites(callSites);

    features.push({
      rootFunction: group.root.functionName ?? "anonymous",
      rootFile: group.root.fileName,
      rootLine: group.root.lineNumber,
      callSites: uniqueCallSites,
      totalCost,
      totalCalls,
      totalInputTokens,
      totalOutputTokens,
      avgDuration: durationCount > 0 ? durationSum / durationCount : 0,
      chains: group.chains,
    });
  }

  // Sort by total cost descending
  features.sort((a, b) => b.totalCost - a.totalCost);
  return features;
}

/**
 * Deduplicate call sites by function name, merging stats across models.
 */
function deduplicateCallSites(callSites: CallSiteRow[]): CallSiteRow[] {
  const byFunction = new Map<string, CallSiteRow>();

  for (const cs of callSites) {
    const key = cs.call_site_key;
    const existing = byFunction.get(key);
    if (existing) {
      existing.total_calls += cs.total_calls;
      existing.total_cost_usd += cs.total_cost_usd;
      existing.total_input_tokens += cs.total_input_tokens;
      existing.total_output_tokens += cs.total_output_tokens;
      existing.avg_duration_ms = (existing.avg_duration_ms + cs.avg_duration_ms) / 2;
    } else {
      byFunction.set(key, { ...cs });
    }
  }

  return [...byFunction.values()].sort((a, b) => b.total_cost_usd - a.total_cost_usd);
}
