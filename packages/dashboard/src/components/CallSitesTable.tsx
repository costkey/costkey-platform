import { ArrowUpDown } from "lucide-react";
import { useState } from "react";
import type { CallSite, EventRow } from "../hooks/useApi";
import { getEvents } from "../api";
import ProviderLogo from "./ProviderLogo";
import EventPanel from "./EventPanel";
import { formatTokens, formatDuration, truncateFile } from "../utils";

interface Props {
  callSites: CallSite[] | null;
  loading: boolean;
  search?: string;
  projectId: string;
}

type SortKey = "total_cost_usd" | "total_calls" | "total_input_tokens" | "avg_duration_ms";

export default function CallSitesTable({ callSites, loading, search = "", projectId }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("total_cost_usd");
  const [selectedEvent, setSelectedEvent] = useState<EventRow | null>(null);

  if (loading || !callSites) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm">
        <div className="p-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-10 bg-surface-overlay rounded-sm animate-pulse mb-2" />
          ))}
        </div>
      </div>
    );
  }

  const aggregated = new Map<string, {
    key: string;
    fileName: string | null;
    functionName: string | null;
    lineNumber: number | null;
    providers: Set<string>;
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
      [...row.providers].some((p) => p.includes(q))
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

  async function handleRowClick(_row: typeof rows[0]) {
    try {
      const data = await getEvents(projectId, { limit: 1 });
      if (data.events.length > 0) setSelectedEvent(data.events[0]);
    } catch { /* silent */ }
  }

  function SortHeader({ label, field }: { label: string; field: SortKey }) {
    const active = sortKey === field;
    return (
      <button
        onClick={() => setSortKey(field)}
        className={`flex items-center gap-1 text-xs uppercase tracking-wider font-medium cursor-pointer transition-colors ${
          active ? "text-accent" : "text-text-muted hover:text-text-secondary"
        }`}
      >
        {label}
        <ArrowUpDown size={10} className={active ? "opacity-100" : "opacity-0"} />
      </button>
    );
  }

  return (
    <>
      <div className="bg-surface-raised border border-border rounded-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-2.5 text-xs uppercase tracking-wider font-medium text-text-muted w-[40%]">
                  Call Site
                </th>
                <th className="px-4 py-2.5"><SortHeader label="Calls" field="total_calls" /></th>
                <th className="px-4 py-2.5"><SortHeader label="Cost" field="total_cost_usd" /></th>
                <th className="px-4 py-2.5"><SortHeader label="Tokens" field="total_input_tokens" /></th>
                <th className="px-4 py-2.5"><SortHeader label="Latency" field="avg_duration_ms" /></th>
                <th className="px-4 py-2.5 w-[100px]">
                  <span className="text-xs uppercase tracking-wider font-medium text-text-muted">Cost %</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-text-muted">
                    {q ? "No matching call sites" : "No call sites yet"}
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-border/30 row-hover cursor-pointer"
                  onClick={() => handleRowClick(row)}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium text-text-primary">
                          {row.functionName ?? "anonymous"}()
                        </span>
                        {[...row.providers].map((p) => (
                          <ProviderLogo key={p} provider={p} size={13} />
                        ))}
                      </div>
                      <span className="font-mono text-xs text-text-muted">
                        {truncateFile(row.fileName)}
                        {row.lineNumber != null && `:${row.lineNumber}`}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-sm text-text-secondary">
                    {row.totalCalls.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-sm font-semibold text-green">
                    ${row.totalCost.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-col font-mono text-xs">
                      <span className="text-text-secondary">{formatTokens(row.totalInputTokens)} in</span>
                      <span className="text-text-muted">{formatTokens(row.totalOutputTokens)} out</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-sm text-text-secondary">
                    {formatDuration(row.avgDuration)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="relative h-2 bg-surface-overlay rounded-sm overflow-hidden">
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
      </div>

      {selectedEvent && (
        <EventPanel event={selectedEvent} projectId={projectId} onClose={() => setSelectedEvent(null)} />
      )}
    </>
  );
}
