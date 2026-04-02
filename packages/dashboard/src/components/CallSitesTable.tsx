import { ArrowUpDown } from "lucide-react";
import { useState } from "react";
import type { CallSite } from "../hooks/useApi";
import ProviderLogo from "./ProviderLogo";

interface Props {
  callSites: CallSite[] | null;
  loading: boolean;
  search?: string;
}

function truncateFile(path: string | null): string {
  if (!path) return "unknown";
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return ".../" + parts.slice(-2).join("/");
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

type SortKey = "total_cost_usd" | "total_calls" | "total_input_tokens" | "avg_duration_ms";

export default function CallSitesTable({ callSites, loading, search = "" }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("total_cost_usd");

  if (loading || !callSites) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm">
        <div className="p-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-8 bg-surface-overlay rounded-sm animate-pulse mb-1" />
          ))}
        </div>
      </div>
    );
  }

  // Aggregate by call_site_key
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
      });
    }
  }

  const q = search.toLowerCase();
  const rows = [...aggregated.values()]
    .filter((row) =>
      !q ||
      (row.functionName ?? "").toLowerCase().includes(q) ||
      (row.fileName ?? "").toLowerCase().includes(q) ||
      [...row.providers].some((p) => p.includes(q)) ||
      [...row.models].some((m) => m.includes(q))
    )
    .sort((a, b) => {
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
        className={`flex items-center gap-0.5 text-[10px] uppercase tracking-wider font-medium cursor-pointer transition-colors ${
          active ? "text-accent" : "text-text-muted hover:text-text-secondary"
        }`}
      >
        {label}
        <ArrowUpDown size={9} className={active ? "opacity-100" : "opacity-0"} />
      </button>
    );
  }

  return (
    <div className="bg-surface-raised border border-border rounded-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-medium text-text-muted w-[40%]">
                Call Site
              </th>
              <th className="px-3 py-2">
                <SortHeader label="Calls" field="total_calls" />
              </th>
              <th className="px-3 py-2">
                <SortHeader label="Cost" field="total_cost_usd" />
              </th>
              <th className="px-3 py-2">
                <SortHeader label="Tokens" field="total_input_tokens" />
              </th>
              <th className="px-3 py-2">
                <SortHeader label="Latency" field="avg_duration_ms" />
              </th>
              <th className="px-3 py-2 w-[100px]">
                <span className="text-[10px] uppercase tracking-wider font-medium text-text-muted">
                  Cost %
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-xs text-text-muted font-mono">
                  {q ? "No matching call sites" : "No call sites yet"}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-border/30 row-hover">
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs font-medium text-text-primary">
                        {row.functionName ?? "anonymous"}()
                      </span>
                      {[...row.providers].map((p) => (
                        <ProviderLogo key={p} provider={p} size={12} />
                      ))}
                    </div>
                    <span className="font-mono text-[10px] text-text-muted">
                      {truncateFile(row.fileName)}
                      {row.lineNumber != null && `:${row.lineNumber}`}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-text-secondary">
                  {row.totalCalls.toLocaleString()}
                </td>
                <td className="px-3 py-2 font-mono text-xs font-medium text-green">
                  ${row.totalCost.toFixed(2)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col font-mono text-[10px]">
                    <span className="text-text-secondary">
                      {formatTokens(row.totalInputTokens)} in
                    </span>
                    <span className="text-text-muted">
                      {formatTokens(row.totalOutputTokens)} out
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-text-secondary">
                  {Math.round(row.avgDuration)}ms
                </td>
                <td className="px-3 py-2">
                  <div className="relative h-1.5 bg-surface-overlay rounded-sm overflow-hidden">
                    <div
                      className="cost-bar absolute inset-y-0 left-0 bg-accent rounded-sm"
                      style={{ width: `${(row.totalCost / maxCost) * 100}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {q && rows.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border text-[10px] text-text-muted font-mono">
          {rows.length} of {aggregated.size} call sites
        </div>
      )}
    </div>
  );
}
