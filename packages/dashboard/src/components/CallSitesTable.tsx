import { FileCode, ArrowUpDown } from "lucide-react";
import { useState } from "react";
import type { CallSite } from "../hooks/useApi";

interface Props {
  callSites: CallSite[] | null;
  loading: boolean;
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: "text-green bg-green-muted",
  anthropic: "text-amber bg-amber-muted",
  google: "text-cyan bg-cyan-muted",
};

function ProviderBadge({ provider }: { provider: string }) {
  const colors = PROVIDER_COLORS[provider] ?? "text-text-secondary bg-surface-overlay";
  return (
    <span className={`text-[10px] font-mono font-medium px-1.5 py-0.5 rounded-sm uppercase tracking-wider ${colors}`}>
      {provider}
    </span>
  );
}

function truncateFile(path: string | null): string {
  if (!path) return "unknown";
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return ".../" + parts.slice(-2).join("/");
}

function formatCost(cost: number): string {
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

type SortKey = "total_cost_usd" | "total_calls" | "total_input_tokens" | "avg_duration_ms";

export default function CallSitesTable({ callSites, loading }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("total_cost_usd");

  if (loading || !callSites) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm animate-in" style={{ animationDelay: "300ms" }}>
        <div className="p-5">
          <div className="h-4 w-40 bg-surface-overlay rounded-sm animate-pulse mb-4" />
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 bg-surface-overlay rounded-sm animate-pulse mb-2" />
          ))}
        </div>
      </div>
    );
  }

  // Aggregate by call_site_key (merge models into one row)
  const aggregated = new Map<string, {
    key: string;
    fileName: string | null;
    functionName: string | null;
    lineNumber: number | null;
    providers: Set<string>;
    models: Set<string>;
    totalCalls: number;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgDuration: number;
    avgTtft: number | null;
  }>();

  for (const cs of callSites) {
    const base = `${cs.file_name}:${cs.function_name}:${cs.line_number}`;
    const existing = aggregated.get(base);
    if (existing) {
      existing.providers.add(cs.provider);
      existing.models.add(cs.model);
      existing.totalCalls += cs.total_calls;
      existing.totalCost += cs.total_cost_usd;
      existing.totalInputTokens += cs.total_input_tokens;
      existing.totalOutputTokens += cs.total_output_tokens;
      existing.avgDuration = (existing.avgDuration + cs.avg_duration_ms) / 2;
      if (cs.avg_ttft != null) {
        existing.avgTtft = existing.avgTtft != null ? (existing.avgTtft + cs.avg_ttft) / 2 : cs.avg_ttft;
      }
    } else {
      aggregated.set(base, {
        key: base,
        fileName: cs.file_name,
        functionName: cs.function_name,
        lineNumber: cs.line_number,
        providers: new Set([cs.provider]),
        models: new Set([cs.model]),
        totalCalls: cs.total_calls,
        totalCost: cs.total_cost_usd,
        totalInputTokens: cs.total_input_tokens,
        totalOutputTokens: cs.total_output_tokens,
        avgDuration: cs.avg_duration_ms,
        avgTtft: cs.avg_ttft,
      });
    }
  }

  const rows = [...aggregated.values()].sort((a, b) => {
    switch (sortKey) {
      case "total_cost_usd": return b.totalCost - a.totalCost;
      case "total_calls": return b.totalCalls - a.totalCalls;
      case "total_input_tokens": return b.totalInputTokens - a.totalInputTokens;
      case "avg_duration_ms": return b.avgDuration - a.avgDuration;
    }
  });

  const maxCost = Math.max(...rows.map((r) => r.totalCost), 0.001);

  function SortHeader({ label, field }: { label: string; field: SortKey }) {
    const active = sortKey === field;
    return (
      <button
        onClick={() => setSortKey(field)}
        className={`flex items-center gap-1 text-[11px] uppercase tracking-wider font-medium cursor-pointer transition-colors ${
          active ? "text-accent" : "text-text-muted hover:text-text-secondary"
        }`}
      >
        {label}
        <ArrowUpDown size={10} className={active ? "opacity-100" : "opacity-0"} />
      </button>
    );
  }

  return (
    <div className="bg-surface-raised border border-border rounded-sm animate-in" style={{ animationDelay: "300ms" }}>
      <div className="flex items-center gap-2 p-4 border-b border-border">
        <FileCode size={14} className="text-accent" />
        <h2 className="text-sm font-medium text-text-secondary tracking-wide uppercase">
          Top Callers
        </h2>
        <span className="font-mono text-xs text-text-muted ml-auto">
          {rows.length} call sites
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-border">
              <th className="px-4 py-3 text-[11px] uppercase tracking-wider font-medium text-text-muted w-[40%]">
                Call Site
              </th>
              <th className="px-4 py-3">
                <SortHeader label="Calls" field="total_calls" />
              </th>
              <th className="px-4 py-3">
                <SortHeader label="Cost" field="total_cost_usd" />
              </th>
              <th className="px-4 py-3">
                <SortHeader label="Tokens" field="total_input_tokens" />
              </th>
              <th className="px-4 py-3">
                <SortHeader label="Latency" field="avg_duration_ms" />
              </th>
              <th className="px-4 py-3 w-[120px]">
                <span className="text-[11px] uppercase tracking-wider font-medium text-text-muted">
                  Cost %
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={row.key}
                className="border-b border-border/50 row-hover cursor-default"
                style={{ animationDelay: `${300 + i * 30}ms` }}
              >
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium text-text-primary">
                        {row.functionName ?? "anonymous"}()
                      </span>
                      {[...row.providers].map((p) => (
                        <ProviderBadge key={p} provider={p} />
                      ))}
                    </div>
                    <span className="font-mono text-xs text-text-muted">
                      {truncateFile(row.fileName)}
                      {row.lineNumber != null && `:${row.lineNumber}`}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-sm text-text-secondary">
                  {row.totalCalls.toLocaleString()}
                </td>
                <td className="px-4 py-3 font-mono text-sm font-medium text-green">
                  {formatCost(row.totalCost)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col font-mono text-xs">
                    <span className="text-text-secondary">
                      {formatTokens(row.totalInputTokens)} in
                    </span>
                    <span className="text-text-muted">
                      {formatTokens(row.totalOutputTokens)} out
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-sm text-text-secondary">
                  {Math.round(row.avgDuration)}ms
                </td>
                <td className="px-4 py-3">
                  <div className="relative h-2 bg-surface-overlay rounded-sm overflow-hidden">
                    <div
                      className="cost-bar absolute inset-y-0 left-0 bg-accent rounded-sm"
                      style={{
                        width: `${(row.totalCost / maxCost) * 100}%`,
                        animationDelay: `${400 + i * 40}ms`,
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
