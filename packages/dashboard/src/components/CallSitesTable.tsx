import { ArrowUpDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { CallSite, EventRow } from "../hooks/useApi";
import { getEvents } from "../api";
import ProviderLogo from "./ProviderLogo";
import EventPanel from "./EventPanel";
import {
  formatTokens, formatDuration, truncateFile, truncateModel, timeAgo,
  findBusinessFrame, parseFrames, cleanFunctionName,
} from "../utils";

interface Props {
  callSites: CallSite[] | null;
  loading: boolean;
  search?: string;
  projectId: string;
}

type SortKey = "total_cost_usd" | "total_calls" | "total_input_tokens" | "avg_duration_ms";

interface AggRow {
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
}

function CallSiteRow({ row, maxCost, projectId, onSelectEvent }: {
  row: AggRow; maxCost: number; projectId: string; onSelectEvent: (e: EventRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(false);

  async function toggle() {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (!events) {
      setLoadingEvents(true);
      try {
        // Fetch events and filter by matching business logic function
        const data = await getEvents(projectId, { limit: 50 });
        const targetFn = row.functionName ?? "";
        const targetFile = row.fileName ?? "";
        const matching = data.events.filter((e) => {
          const frames = parseFrames(e.call_site_frames);
          const best = findBusinessFrame(frames);
          const fn = cleanFunctionName(best?.functionName) ?? "";
          const file = best?.fileName ?? "";
          return fn === targetFn || file === targetFile;
        });
        setEvents(matching.length > 0 ? matching.slice(0, 20) : data.events.slice(0, 5));
      } catch { /* silent */ }
      setLoadingEvents(false);
    }
  }

  return (
    <div className="border-b border-border/30 row-striped">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-3 px-5 py-3.5 row-hover cursor-pointer text-left"
      >
        <ChevronRight
          size={14}
          className={`text-text-muted shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-text-primary truncate">
              {row.functionName ?? "anonymous"}()
            </span>
            {[...row.providers].map((p) => (
              <ProviderLogo key={p} provider={p} size={14} />
            ))}
          </div>
          <span className="font-mono text-xs text-text-muted truncate">
            {truncateFile(row.fileName)}
            {row.lineNumber != null && `:${row.lineNumber}`}
          </span>
        </div>
        <span className="font-mono text-sm text-text-secondary w-16 text-right shrink-0">
          {row.totalCalls.toLocaleString()}
        </span>
        <span className="font-mono text-sm font-semibold text-green w-20 text-right shrink-0">
          ${row.totalCost.toFixed(4)}
        </span>
        <span className="font-mono text-xs text-text-muted w-20 text-right shrink-0">
          {formatTokens(row.totalInputTokens)} in
        </span>
        <span className="font-mono text-sm text-text-secondary w-20 text-right shrink-0">
          {formatDuration(row.avgDuration)}
        </span>
        <div className="w-24 shrink-0">
          <div className="relative h-2 bg-surface-overlay rounded-sm overflow-hidden">
            <div
              className="cost-bar absolute inset-y-0 left-0 bg-accent rounded-sm"
              style={{ width: `${(row.totalCost / maxCost) * 100}%` }}
            />
          </div>
        </div>
      </button>

      {expanded && (
        <div className="bg-surface/50 border-t border-border/20 animate-expand">
          {loadingEvents && (
            <div className="flex items-center gap-2 px-6 py-3">
              <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-text-muted">Loading events...</span>
            </div>
          )}
          {events && events.length > 0 && (
            <div>
              <div className="flex items-center gap-3 px-6 py-1.5 text-[10px] uppercase tracking-wider font-medium text-text-muted border-b border-border/20">
                <div className="w-10">Time</div>
                <div className="w-5" />
                <div className="w-40">Model</div>
                <div className="flex-1">Function</div>
                <div className="w-16 text-right">Tokens</div>
                <div className="w-16 text-right">Latency</div>
                <div className="w-14 text-right">Cost</div>
              </div>
              {events.map((event) => {
                const best = findBusinessFrame(parseFrames(event.call_site_frames));
                const fn = cleanFunctionName(best?.functionName);
                return (
                  <button
                    key={event.id}
                    onClick={(e) => { e.stopPropagation(); onSelectEvent(event); }}
                    className="w-full flex items-center gap-3 px-6 py-2 row-hover cursor-pointer text-left"
                  >
                    <span className="font-mono text-xs text-text-muted w-10 shrink-0">
                      {timeAgo(event.timestamp)}
                    </span>
                    <ProviderLogo provider={event.provider} size={12} />
                    <span className="font-mono text-xs text-text-secondary w-40 truncate shrink-0">
                      {truncateModel(event.model)}
                    </span>
                    <span className="font-mono text-xs text-text-primary truncate flex-1">
                      {fn ? `${fn}()` : "—"}
                    </span>
                    <span className="font-mono text-xs text-text-muted w-16 text-right shrink-0">
                      {event.total_tokens?.toLocaleString() ?? "—"}
                    </span>
                    <span className="font-mono text-xs text-text-muted w-16 text-right shrink-0">
                      {formatDuration(event.duration_ms)}
                    </span>
                    <span className="font-mono text-xs font-medium text-green w-14 text-right shrink-0">
                      ${(event.cost_usd ?? 0).toFixed(4)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {events && events.length === 0 && (
            <div className="px-6 py-3 text-xs text-text-muted">No events found</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CallSitesTable({ callSites, loading, search = "", projectId }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("total_cost_usd");
  const [selectedEvent, setSelectedEvent] = useState<EventRow | null>(null);

  if (loading || !callSites) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm">
        <div className="p-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-12 bg-surface-overlay rounded-sm animate-pulse mb-2" />
          ))}
        </div>
      </div>
    );
  }

  const aggregated = new Map<string, AggRow>();
  for (const cs of callSites) {
    const base = `${cs.file_name}:${cs.function_name}`; // aggregate by function, not line number
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
        key: base, fileName: cs.file_name, functionName: cs.function_name,
        lineNumber: cs.line_number, providers: new Set([cs.provider]),
        totalCalls: cs.total_calls, totalCost: cs.total_cost_usd,
        totalInputTokens: cs.total_input_tokens, totalOutputTokens: cs.total_output_tokens,
        avgDuration: cs.avg_duration_ms,
      });
    }
  }

  const q = search.toLowerCase();
  const rows = [...aggregated.values()]
    .filter((row) =>
      !q || (row.functionName ?? "").toLowerCase().includes(q) ||
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
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
          <div className="w-3.5" />
          <div className="flex-1 text-xs uppercase tracking-wider font-medium text-text-muted">Call Site</div>
          <div className="w-16 text-right"><SortHeader label="Calls" field="total_calls" /></div>
          <div className="w-20 text-right"><SortHeader label="Cost" field="total_cost_usd" /></div>
          <div className="w-20 text-right"><SortHeader label="Tokens" field="total_input_tokens" /></div>
          <div className="w-20 text-right"><SortHeader label="Latency" field="avg_duration_ms" /></div>
          <div className="w-24 text-xs uppercase tracking-wider font-medium text-text-muted">Share</div>
        </div>

        <div className="max-h-[calc(100vh-200px)] overflow-y-auto">
          {rows.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-text-muted">
              {q ? "No matching call sites" : "No call sites yet"}
            </div>
          )}
          {rows.map((row) => (
            <CallSiteRow
              key={row.key} row={row} maxCost={maxCost}
              projectId={projectId} onSelectEvent={setSelectedEvent}
            />
          ))}
        </div>
      </div>

      {selectedEvent && (
        <EventPanel event={selectedEvent} projectId={projectId} onClose={() => setSelectedEvent(null)} />
      )}
    </>
  );
}
