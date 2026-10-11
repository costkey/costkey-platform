/**
 * Python call graph scoring, on the server. SDK 0.7 uploads the raw static
 * graph: `functions` keyed "path:function", each
 * `{ line, callees: ["path:function", ...], callExpressions: ["client.chat.completions.create", ...] }`.
 * The server decides which expressions are AI calls and computes fan-in, AI
 * distance and the attribution score (a port of costkey-python 0.6
 * `compute_scores`). The older pre-scored payload is still accepted.
 */

export interface ScoredFunction {
  score: number;
  fan_in: number;
  calls_ai: boolean;
  line: number;
}

/** Attribute-chain suffixes that call an AI provider. */
const AI_CALL_PATTERNS: readonly string[][] = [
  ["messages", "create"],                 // Anthropic
  ["chat", "completions", "create"],      // OpenAI
  ["completions", "create"],              // OpenAI (legacy completions)
  ["generate_content"],                   // Google
  // Beyond SDK 0.6:
  ["responses", "create"],                // OpenAI Responses API
  ["embeddings", "create"],               // OpenAI embeddings
  ["generate_content_async"],             // google-generativeai async
  ["messages", "stream"],                 // Anthropic streaming helper
  ["converse"], ["converse_stream"],      // Bedrock
  ["invoke_model"], ["invoke_model_with_response_stream"],
];

/** Whether a dotted call expression (`client.chat.completions.create`) calls an AI provider. */
export function isAiCallExpression(expression: string): boolean {
  const chain = expression.split(".").map((part) => part.trim()).filter(Boolean);
  return AI_CALL_PATTERNS.some((pattern) =>
    chain.length >= pattern.length && pattern.every((part, index) => chain[chain.length - pattern.length + index] === part));
}

interface RawFunction {
  line: number;
  callees: string[];
  callsAi: boolean;
}

const MAX_FUNCTIONS = 20_000;

/** Whether an upload is the raw (0.7) format rather than pre-scored. */
export function isRawCallGraph(functions: Record<string, unknown>): boolean {
  return Object.values(functions).some((value) => {
    const entry = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    return !!entry && (Array.isArray(entry["callees"]) || Array.isArray(entry["callExpressions"]) || Array.isArray(entry["call_expressions"]))
      && typeof entry["score"] !== "number";
  });
}

function parseRaw(functions: Record<string, unknown>): Map<string, RawFunction> {
  const graph = new Map<string, RawFunction>();
  for (const [key, value] of Object.entries(functions).slice(0, MAX_FUNCTIONS)) {
    if (!key.includes(":") || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const line = typeof entry["line"] === "number" && Number.isFinite(entry["line"])
      ? entry["line"]
      : typeof entry["lineno"] === "number" ? entry["lineno"] : 0;
    const strings = (raw: unknown): string[] => Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 500)
      : [];
    const expressions = strings(entry["callExpressions"] ?? entry["call_expressions"]);
    graph.set(key, {
      line,
      callees: strings(entry["callees"]),
      callsAi: entry["calls_ai"] === true || expressions.some(isAiCallExpression),
    });
  }
  return graph;
}

function fileOf(key: string): string {
  return key.slice(0, key.lastIndexOf(":"));
}

function functionOf(key: string): string {
  return key.slice(key.lastIndexOf(":") + 1);
}

/** fan-in, AI distance (BFS from AI-calling functions) and score, for functions within 3 hops of an AI call. */
export function computeCallGraphScores(functions: Record<string, unknown>): Record<string, ScoredFunction> {
  const graph = parseRaw(functions);
  const byName = new Map<string, string[]>();
  for (const key of graph.keys()) {
    const name = functionOf(key);
    byName.set(name, [...(byName.get(name) ?? []), key]);
  }
  // A callee is a full "path:function" key, or (legacy) a bare name tried in
  // the caller's file first, then any file.
  const resolve = (caller: string, callee: string): string | null => {
    if (graph.has(callee)) return callee;
    const name = callee.includes(":") ? functionOf(callee) : callee;
    const local = `${fileOf(caller)}:${name}`;
    if (graph.has(local)) return local;
    return byName.get(name)?.[0] ?? null;
  };

  const fanIn = new Map<string, number>([...graph.keys()].map((key) => [key, 0]));
  const adjacency = new Map<string, string[]>();
  for (const [key, entry] of graph) {
    const resolved: string[] = [];
    for (const callee of entry.callees) {
      const target = resolve(key, callee);
      if (!target) continue;
      fanIn.set(target, (fanIn.get(target) ?? 0) + 1);
      resolved.push(target);
    }
    adjacency.set(key, resolved);
  }

  const reverse = new Map<string, string[]>([...graph.keys()].map((key) => [key, []]));
  for (const [key, callees] of adjacency) {
    for (const callee of callees) reverse.get(callee)?.push(key);
  }

  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const [key, entry] of graph) {
    if (entry.callsAi) {
      distance.set(key, 0);
      queue.push(key);
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    const next = distance.get(current)! + 1;
    for (const neighbor of [...(reverse.get(current) ?? []), ...(adjacency.get(current) ?? [])]) {
      if (!distance.has(neighbor)) {
        distance.set(neighbor, next);
        queue.push(neighbor);
      }
    }
  }

  const result: Record<string, ScoredFunction> = {};
  for (const [key, entry] of graph) {
    const dist = distance.get(key);
    if (dist === undefined || dist > 3) continue;
    const fi = fanIn.get(key) ?? 0;
    let score = fi * 10;
    if (entry.callsAi) score += 5;
    if (dist === 1) score -= 15;
    else if (dist === 2) score -= 10;
    result[key] = { line: entry.line, score, fan_in: fi, calls_ai: entry.callsAi };
  }
  return result;
}

/** The stored graph for an upload: raw functions are scored; a pre-scored payload is kept as sent. */
export function callGraphFromUpload(functions: Record<string, unknown>): Record<string, ScoredFunction> {
  if (isRawCallGraph(functions)) return computeCallGraphScores(functions);
  return functions as Record<string, ScoredFunction>;
}
