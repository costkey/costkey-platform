import type { FindingResponse } from "../api";

/**
 * Plain-language view of a cost finding ("This run needs a look"), built only
 * from the fields the server records for each finding family. Nothing here
 * guesses a cause: the copy names the comparison, the amounts and the runs.
 */
export interface FindingView {
  title: string;
  summary: string;
  scopeLabels: string[];
  metrics: Array<{ label: string; value: string; detail?: string }>;
  facts: Array<{ label: string; value: string }>;
  traceIds: string[];
  nextSteps: string[];
}

type Money = (value: number | null | undefined) => string;

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function percent(fraction: number | null): string {
  if (fraction == null) return "—";
  return `${Math.round(fraction * 100)}%`;
}

/** Coverage values arrive as 0–1 fractions; tolerate 0–100 percentages. */
function coverage(value: unknown): number | null {
  const numeric = num(value);
  if (numeric == null) return null;
  return numeric > 1 ? numeric / 100 : numeric;
}

function ids(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(ids);
  return [];
}

function scopeName(scope: Record<string, unknown>): string | null {
  for (const key of ["feature", "function", "operation", "model", "customer"]) {
    const value = scope[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function findingTitle(finding: Pick<FindingResponse, "family" | "scope" | "evidence">): string {
  const name = scopeName(finding.scope ?? {});
  const evidence = finding.evidence ?? {};
  switch (finding.family) {
    case "increased_unit_cost": return name ? `${name} costs more per run` : "Cost per run went up";
    case "expensive_trace": return "An unusually expensive run";
    case "coverage_deterioration": return (num(evidence["pricingDrop"]) ?? 0) >= (num(evidence["attributionDrop"]) ?? 0) ? "Fewer calls have a price" : "Fewer calls are labelled";
    case "allowance_trajectory": {
      const policy = typeof evidence["policyName"] === "string" && evidence["policyName"] ? String(evidence["policyName"]) : "A budget";
      return (num(evidence["highestRatio"]) ?? 0) >= 1 ? `${policy} reached its limit` : `${policy} is close to its limit`;
    }
    default: return "A cost change";
  }
}

export function findingView(finding: FindingResponse, money: Money): FindingView {
  const evidence = finding.evidence ?? {};
  const baseline = finding.baseline ?? {};
  const scope = finding.scope ?? {};
  const scopeLabels = Object.entries(scope)
    .filter(([key, value]) => key !== "dimension" && typeof value === "string" && value.trim())
    .map(([key, value]) => key === "value" ? String(value) : `${key.charAt(0).toUpperCase()}${key.slice(1)}: ${String(value)}`);
  const affected = ids(evidence["affectedTraceIds"]);
  const supporting = ids(evidence["supportingTraceIds"]);
  const traceIds = [...new Set([...affected, ...supporting])];
  const title = findingTitle(finding);

  if (finding.family === "increased_unit_cost") {
    const current = num(evidence["currentUnitCost"]);
    const previous = num(baseline["previousUnitCost"] ?? evidence["previousUnitCost"] ?? baseline["unitCost"]);
    const currentCount = num(evidence["currentCount"] ?? evidence["currentTraceCount"] ?? evidence["currentTraces"]);
    const previousCount = num(baseline["previousCount"] ?? evidence["previousTraceCount"] ?? evidence["previousTraces"] ?? baseline["traceCount"]);
    const relative = num(evidence["relativeDifference"]) ?? (current != null && previous ? current / previous - 1 : null);
    const currentCost = num(evidence["currentCost"]) ?? (current != null && currentCount != null ? current * currentCount : null);
    const previousCost = num(baseline["previousCost"]) ?? (previous != null && previousCount != null ? previous * previousCount : null);
    const excluded = num((evidence["excludedUnpriced"] as Record<string, unknown> | undefined)?.["current"]);
    return {
      title,
      summary: current != null && previous != null
        ? `Each run cost ${money(current)} on average, up from ${money(previous)}${relative != null ? ` (${percent(relative)} more)` : ""}${currentCount != null ? `, across ${currentCount.toLocaleString()} runs` : ""}.`
        : "Cost per run is higher than in the previous period.",
      scopeLabels,
      metrics: [
        { label: "Cost per run", value: money(current), detail: previous != null ? `Before: ${money(previous)}` : undefined },
        { label: "Change per run", value: current != null && previous != null ? `+${money(current - previous)}` : "—", detail: relative != null ? `${percent(relative)} more` : undefined },
      ],
      facts: [
        { label: "This period", value: `${currentCount == null ? "—" : `${currentCount.toLocaleString()} runs`} · ${money(currentCost)}` },
        { label: "Previous period", value: `${previousCount == null ? "—" : `${previousCount.toLocaleString()} runs`} · ${money(previousCost)}` },
        ...(currentCount != null && previousCount != null ? [{ label: "Change in volume", value: `${currentCount - previousCount >= 0 ? "+" : ""}${(currentCount - previousCount).toLocaleString()} runs` }] : []),
        ...(excluded ? [{ label: "Left out", value: `${excluded.toLocaleString()} runs without a price` }] : []),
      ],
      traceIds,
      nextSteps: ["Open a recent run and compare its calls with an older one.", "Check for model, prompt or retry changes in the latest release."],
    };
  }

  if (finding.family === "expensive_trace") {
    const cost = num(evidence["traceCost"]);
    const median = num(baseline["medianCost"]);
    const comparable = num(baseline["comparableTraces"]);
    const multiple = cost != null && median ? cost / median : null;
    return {
      title,
      summary: cost != null && median != null
        ? `One run cost ${money(cost)}${multiple != null ? `, about ${multiple.toFixed(1)}× ` : ", more than "}the usual ${money(median)} for similar runs.`
        : "One run cost much more than similar runs.",
      scopeLabels,
      metrics: [
        { label: "This run", value: money(cost) },
        { label: "Usual cost", value: money(median), detail: comparable != null ? `Median of ${comparable.toLocaleString()} similar runs` : undefined },
      ],
      facts: [],
      traceIds: [...new Set([...affected, ...supporting])],
      nextSteps: ["Open the run to see which call cost the most.", "Compare it with a typical run."],
    };
  }

  if (finding.family === "coverage_deterioration") {
    const pricingNow = coverage(evidence["currentPricingCoverage"]);
    const pricingBefore = coverage(baseline["previousPricingCoverage"]);
    const labelsNow = coverage(evidence["currentAttributionCoverage"]);
    const labelsBefore = coverage(baseline["previousAttributionCoverage"]);
    const pricing = (num(evidence["pricingDrop"]) ?? 0) >= (num(evidence["attributionDrop"]) ?? 0);
    const unpriced = num(evidence["unpricedCount"]);
    const unlabelled = num(evidence["unattributedCount"]);
    return {
      title,
      summary: pricing
        ? `${percent(pricingNow)} of calls have a price, down from ${percent(pricingBefore)}. Totals leave out the rest.`
        : `${percent(labelsNow)} of calls have a feature label, down from ${percent(labelsBefore)}.`,
      scopeLabels,
      metrics: [
        { label: "Calls priced", value: percent(pricingNow), detail: `Before: ${percent(pricingBefore)}` },
        { label: "Calls labelled", value: percent(labelsNow), detail: `Before: ${percent(labelsBefore)}` },
      ],
      facts: [
        ...(unpriced != null ? [{ label: "Calls without a price", value: unpriced.toLocaleString() }] : []),
        ...(unlabelled != null ? [{ label: "Calls without a label", value: unlabelled.toLocaleString() }] : []),
      ],
      traceIds,
      nextSteps: pricing
        ? ["Check the models you use are supported, or add a custom rate in Settings.", "Look at the calls without a price."]
        : ["Send a feature label from the SDK.", "Or add a label rule on the Costs page."],
    };
  }

  if (finding.family === "allowance_trajectory") {
    const monthlySpend = num(evidence["monthlySpend"]);
    const monthlyLimit = num(evidence["monthlyLimit"]);
    const dailySpend = num(evidence["dailySpend"]);
    const dailyLimit = num(evidence["dailyLimit"]);
    const ratio = num(evidence["highestRatio"]);
    const spend = monthlyLimit != null ? monthlySpend : dailySpend;
    const limit = monthlyLimit ?? dailyLimit;
    return {
      title,
      summary: spend != null && limit != null ? `${money(spend)} of ${money(limit)} used ${monthlyLimit != null ? "this month" : "today"}.` : "Spending is close to a budget limit.",
      scopeLabels,
      metrics: [
        { label: "Used", value: percent(ratio), detail: spend != null ? money(spend) : undefined },
        { label: "Limit", value: money(limit), detail: monthlyLimit != null ? "Per month" : dailyLimit != null ? "Per day" : undefined },
      ],
      facts: [],
      traceIds,
      nextSteps: ["Review the budget and who it covers.", "See which runs used most of it."],
    };
  }

  return { title, summary: "Open the runs below to see what changed.", scopeLabels, metrics: [], facts: [], traceIds, nextSteps: ["Open the runs below to see what changed."] };
}
