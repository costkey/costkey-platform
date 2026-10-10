import type { TraceEvent, TraceSpan } from "../api";

export interface RunTreeSpanNode {
  type: "span";
  id: string;
  span: TraceSpan;
  depth: number;
  children: RunTreeNode[];
  /** Known cost of every call beneath this span; null when none is priced. */
  cost: number | null;
  unpriced: number;
  calls: number;
  startMs: number;
  endMs: number;
}

export interface RunTreeCallNode {
  type: "call";
  id: string;
  event: TraceEvent;
  depth: number;
  startMs: number;
  endMs: number;
}

export type RunTreeNode = RunTreeSpanNode | RunTreeCallNode;

function time(value: string | null | undefined): number {
  const parsed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Nest spans by parent and hang each call under the span it ran inside.
 * Spans whose parent is missing (or that would form a cycle) become roots, as
 * do calls without a span, so nothing recorded is ever dropped from the view.
 */
export function buildRunTree(spans: TraceSpan[], events: TraceEvent[]): RunTreeNode[] {
  const byId = new Map(spans.map((span) => [span.id, span]));
  const nodes = new Map<string, RunTreeSpanNode>();
  for (const span of spans) {
    const start = time(span.started_at);
    const end = time(span.ended_at);
    nodes.set(span.id, {
      type: "span", id: span.id, span, depth: 0, children: [], cost: null, unpriced: 0, calls: 0,
      startMs: start, endMs: Number.isFinite(end) ? end : start,
    });
  }

  const roots: RunTreeNode[] = [];
  const reachesRootWithoutCycle = (id: string): boolean => {
    const seen = new Set<string>();
    let current: string | null = id;
    while (current) {
      if (seen.has(current)) return false;
      seen.add(current);
      const parent: string | null = byId.get(current)?.parent_span_id ?? null;
      current = parent && byId.has(parent) ? parent : null;
    }
    return true;
  };
  for (const node of nodes.values()) {
    const parentId = node.span.parent_span_id;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent && parent !== node && reachesRootWithoutCycle(node.id)) parent.children.push(node);
    else roots.push(node);
  }

  for (const event of events) {
    const start = time(event.timestamp);
    const call: RunTreeCallNode = {
      type: "call", id: event.id, event, depth: 0,
      startMs: start, endMs: Number.isFinite(start) ? start + (Number(event.duration_ms) || 0) : start,
    };
    const owner = event.span_id ? nodes.get(event.span_id) : undefined;
    if (owner) owner.children.push(call);
    else roots.push(call);
  }

  const order = (a: RunTreeNode, b: RunTreeNode): number => {
    const left = Number.isFinite(a.startMs) ? a.startMs : Number.POSITIVE_INFINITY;
    const right = Number.isFinite(b.startMs) ? b.startMs : Number.POSITIVE_INFINITY;
    return left - right || a.id.localeCompare(b.id);
  };
  const finish = (list: RunTreeNode[], depth: number): void => {
    list.sort(order);
    for (const node of list) {
      node.depth = depth;
      if (node.type !== "span") continue;
      finish(node.children, depth + 1);
      let cost: number | null = null;
      let unpriced = 0;
      let calls = 0;
      for (const child of node.children) {
        if (child.type === "call") {
          calls += 1;
          if (child.event.cost_usd == null) unpriced += 1;
          else cost = (cost ?? 0) + Number(child.event.cost_usd);
          if (Number.isFinite(child.endMs)) node.endMs = Number.isFinite(node.endMs) ? Math.max(node.endMs, child.endMs) : child.endMs;
        } else {
          calls += child.calls;
          unpriced += child.unpriced;
          if (child.cost != null) cost = (cost ?? 0) + child.cost;
          if (Number.isFinite(child.endMs)) node.endMs = Number.isFinite(node.endMs) ? Math.max(node.endMs, child.endMs) : child.endMs;
        }
      }
      node.cost = cost;
      node.unpriced = unpriced;
      node.calls = calls;
    }
  };
  finish(roots, 0);
  return roots;
}

/** Depth-first rows, skipping the children of collapsed spans. */
export function flattenRunTree(roots: RunTreeNode[], collapsed: ReadonlySet<string>): RunTreeNode[] {
  const rows: RunTreeNode[] = [];
  const visit = (list: RunTreeNode[]): void => {
    for (const node of list) {
      rows.push(node);
      if (node.type === "span" && !collapsed.has(node.id)) visit(node.children);
    }
  };
  visit(roots);
  return rows;
}

/** Long agent loops start with their steps folded so the run stays readable. */
export function defaultCollapsed(spans: TraceSpan[]): Set<string> {
  if (spans.length <= 40) return new Set();
  return new Set(spans.filter((span) => span.kind === "step").map((span) => span.id));
}

export const SPAN_KIND_LABEL: Record<string, string> = {
  agent: "Agent",
  step: "Step",
  tool: "Tool",
  workflow: "Workflow",
  task: "Task",
  judge: "Judge",
  retrieval: "Retrieval",
  handoff: "Handoff",
  guardrail: "Guardrail",
  chain: "Chain",
  custom: "Span",
};

/** Step spans share one name; their step number makes each row distinct. */
export function spanTitle(span: TraceSpan): string {
  const number = span.attributes?.["step"];
  if (span.kind === "step" && (typeof number === "number" || typeof number === "string") && span.name === "step") {
    return `Step ${number}`;
  }
  return span.name;
}
