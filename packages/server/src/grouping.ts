/**
 * Call chain grouping engine.
 *
 * Groups call sites into "features" by analyzing stack traces
 * and finding the most meaningful shared ancestor — NOT just the top of the stack.
 *
 * Key insight: A function that dispatches to many unrelated AI calls
 * (like a router or switch/case handler) should NOT be the feature root.
 * Instead, we find the Lowest Meaningful Ancestor (LMA):
 *
 *   1. Group by root (top of stack) initially
 *   2. For each group, check if the root is a "dispatcher" (fans out to
 *      unrelated subtrees with no shared intermediate frames)
 *   3. If dispatcher detected: split the group at the next meaningful level
 *   4. Repeat until groups are cohesive
 *
 * This means:
 *   extractAgentData → processEmail → summarizeEmail
 *   extractAgentData → generateReport
 *   extractAgentData → translateMessage
 *
 * Becomes THREE features (processEmail, generateReport, translateMessage)
 * instead of one useless "extractAgentData" bucket.
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
  rootFunction: string;
  rootFile: string | null;
  rootLine: number | null;
  callSites: CallSiteRow[];
  totalCost: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgDuration: number;
  chains: CallChain[];
}

export interface CallChain {
  frames: { functionName: string; fileName: string | null; lineNumber: number | null }[];
  callSiteKey: string;
}

type FrameKey = string;

function frameKey(f: StackFrame): FrameKey {
  return `${f.functionName}@${f.fileName}`;
}

interface Group {
  root: StackFrame;
  callSiteKeys: Set<string>;
  chains: CallChain[];
  traces: Map<string, StackFrame[]>; // callSiteKey → trace
}

export function groupIntoFeatures(
  callSiteStats: CallSiteRow[],
  eventFrames: EventFrames[],
): Feature[] {
  // Step 1: Collect best trace per call site
  const bestTrace = new Map<string, StackFrame[]>();
  const callSiteTraces = new Map<string, StackFrame[][]>();

  for (const ef of eventFrames) {
    if (ef.frames.length === 0) continue;
    const existing = callSiteTraces.get(ef.call_site_key) ?? [];
    const key = ef.frames.map((f) => frameKey(f)).join("|");
    if (!existing.some((t) => t.map((f) => frameKey(f)).join("|") === key)) {
      existing.push(ef.frames);
    }
    callSiteTraces.set(ef.call_site_key, existing);
  }

  for (const [key, traces] of callSiteTraces) {
    bestTrace.set(key, traces.reduce((a, b) => (a.length >= b.length ? a : b), []));
  }

  // Step 2: Initial grouping by root (top of stack)
  const rootGroups = new Map<FrameKey, Group>();

  for (const [callSiteKey, trace] of bestTrace) {
    if (trace.length === 0) continue;
    const rootFrame = trace[trace.length - 1];
    const rk = frameKey(rootFrame);

    const group = rootGroups.get(rk) ?? {
      root: rootFrame,
      callSiteKeys: new Set(),
      chains: [] as CallChain[],
      traces: new Map(),
    };

    group.callSiteKeys.add(callSiteKey);
    group.traces.set(callSiteKey, trace);
    group.chains.push({
      frames: trace.map((f) => ({
        functionName: f.functionName ?? "anonymous",
        fileName: f.fileName,
        lineNumber: f.lineNumber,
      })),
      callSiteKey,
    });

    rootGroups.set(rk, group);
  }

  // Step 3: Split dispatcher groups
  // A group is a "dispatcher" if:
  //   - It has 3+ call sites AND
  //   - The call sites have no shared intermediate frames (besides the root)
  // In that case, push the root down one level for each subtree.
  const finalGroups: Group[] = [];

  for (const group of rootGroups.values()) {
    const split = splitIfDispatcher(group);
    finalGroups.push(...split);
  }

  // Step 4: Build Feature objects
  const features: Feature[] = [];

  for (const group of finalGroups) {
    const callSites: CallSiteRow[] = [];
    let totalCost = 0;
    let totalCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let durationSum = 0;
    let durationCount = 0;

    const seenKeys = new Set<string>();
    for (const key of group.callSiteKeys) {
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

  features.sort((a, b) => b.totalCost - a.totalCost);
  return features;
}

/**
 * Split a group if the root is a dispatcher (fans out to unrelated subtrees).
 *
 * Logic:
 *   For each call site, look at the frame just below the root (the "child frame").
 *   If child frames are mostly unique (few shared), the root is a dispatcher.
 *   Split into sub-groups by the shared intermediate frames.
 */
function splitIfDispatcher(group: Group): Group[] {
  // Don't split small groups
  if (group.callSiteKeys.size <= 2) return [group];

  // For each call site, find the "child frame" — the frame just below the root
  const childFrames = new Map<string, { frame: StackFrame; callSiteKeys: Set<string>; chains: CallChain[]; traces: Map<string, StackFrame[]> }>();

  for (const [callSiteKey, trace] of group.traces) {
    if (trace.length <= 1) {
      // Only one frame — can't split further, keep in root group
      const rk = "__single__";
      const existing = childFrames.get(rk) ?? {
        frame: group.root,
        callSiteKeys: new Set(),
        chains: [] as CallChain[],
        traces: new Map(),
      };
      existing.callSiteKeys.add(callSiteKey);
      existing.traces.set(callSiteKey, trace);
      existing.chains.push({
        frames: trace.map((f) => ({ functionName: f.functionName ?? "anonymous", fileName: f.fileName, lineNumber: f.lineNumber })),
        callSiteKey,
      });
      childFrames.set(rk, existing);
      continue;
    }

    // The child is the second-to-last frame (one below root)
    const childFrame = trace[trace.length - 2];
    const ck = frameKey(childFrame);

    const existing = childFrames.get(ck) ?? {
      frame: childFrame,
      callSiteKeys: new Set(),
      chains: [] as CallChain[],
      traces: new Map() as Map<string, StackFrame[]>,
    };

    existing.callSiteKeys.add(callSiteKey);
    existing.traces.set(callSiteKey, trace);
    existing.chains.push({
      frames: trace.map((f) => ({ functionName: f.functionName ?? "anonymous", fileName: f.fileName, lineNumber: f.lineNumber })),
      callSiteKey,
    });
    childFrames.set(ck, existing);
  }

  // If most child frames are unique (each has only 1 call site),
  // the root IS a dispatcher — use the children as feature roots instead.
  const uniqueChildren = [...childFrames.values()].filter((c) => c.callSiteKeys.size === 1).length;
  const totalChildren = childFrames.size;
  const isDispatcher = totalChildren >= 3 && uniqueChildren >= totalChildren * 0.6;

  if (!isDispatcher) {
    // Not a dispatcher — keep the group as-is
    return [group];
  }

  // Split: each child frame becomes a new group root
  // But merge children that share the same child frame (those ARE related)
  const subGroups: Group[] = [];

  for (const [ck, child] of childFrames) {
    if (ck === "__single__") {
      // Single-frame traces stay under original root
      subGroups.push({
        root: group.root,
        callSiteKeys: child.callSiteKeys,
        chains: child.chains,
        traces: child.traces,
      });
      continue;
    }

    // Use the child frame as the new root
    // But if this sub-group also looks like a dispatcher, recurse
    const subGroup: Group = {
      root: child.frame,
      callSiteKeys: child.callSiteKeys,
      chains: child.chains,
      traces: child.traces,
    };

    // Recurse — but only one level deep to prevent infinite splits
    if (child.callSiteKeys.size > 2) {
      subGroups.push(...splitIfDispatcher(subGroup));
    } else {
      subGroups.push(subGroup);
    }
  }

  return subGroups;
}

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
