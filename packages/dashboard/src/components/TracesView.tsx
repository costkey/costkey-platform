import { useState } from "react";
import { ChevronRight, Clock, Circle } from "lucide-react";
import type { Trace } from "../hooks/useApi";
import { getTrace, type TraceEvent } from "../api";
import ProviderLogo, { ProviderDot } from "./ProviderLogo";
import { truncateModel, timeAgo, formatDuration, cleanFunctionName } from "../utils";

interface Props {
  traces: Trace[] | null;
  loading: boolean;
  projectId: string;
  search?: string;
}

const PROVIDER_BAR_COLORS: Record<string, string> = {
  openai: "bg-green/70",
  anthropic: "bg-amber/70",
  google: "bg-cyan/70",
};

function TraceRow({ trace, projectId }: { trace: Trace; projectId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<TraceEvent[] | null>(null);
  const [loading, setLoading] = useState(false);

  const models = trace.models.split(",").map((m) => truncateModel(m.trim()));
  const providers = trace.providers.split(",").map((p) => p.trim());

  async function toggle() {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (!events) {
      setLoading(true);
      try {
        const data = await getTrace(projectId, trace.trace_id);
        setEvents(data.events);
      } catch { /* silent */ }
      setLoading(false);
    }
  }

  return (
    <div className="border-b border-border/30 last:border-b-0 row-striped">
      <button
        onClick={toggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-4 px-5 py-3 row-hover cursor-pointer text-left"
      >
        <ChevronRight
          size={12}
          className={`text-text-muted shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />

        {/* Provider logos */}
        <div className="flex gap-1 shrink-0">
          {providers.map((p, i) => (
            <ProviderLogo key={i} provider={p} size={16} />
          ))}
        </div>

        {/* Trace name */}
        <span className="font-mono text-sm font-medium text-text-primary truncate min-w-0">
          {trace.trace_name ?? trace.trace_id}
        </span>

        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-surface-overlay text-text-secondary shrink-0">
          {trace.call_count}
        </span>

        <span className="font-mono text-xs text-text-muted truncate flex-1 min-w-0">
          {models.join(", ")}
        </span>

        <span className="font-mono text-xs text-text-muted w-16 text-right shrink-0">
          {timeAgo(trace.started_at)}
        </span>

        <span className="font-mono text-xs text-text-muted w-20 text-right shrink-0">
          {formatDuration(trace.total_duration_ms)}
        </span>

        <span className="font-mono text-xs text-text-muted w-16 text-right shrink-0">
          {((trace.total_input_tokens + trace.total_output_tokens) / 1000).toFixed(1)}k
        </span>

        <span className="font-mono text-sm font-semibold text-green w-24 text-right shrink-0">
          ${trace.total_cost.toFixed(4)}
        </span>
      </button>

      {expanded && (
        <div className="bg-surface/50 px-4 py-2 pb-3">
          {loading && (
            <div className="flex items-center gap-2 py-1.5">
              <div className="w-3 h-3 border border-text-secondary border-t-transparent rounded-full animate-spin" />
              <span className="text-[10px] text-text-muted">Loading...</span>
            </div>
          )}
          {events && events.length > 0 && (
            <div className="flex flex-col gap-0">
              <div className="flex items-center gap-2 px-1.5 py-1 text-[9px] uppercase tracking-wider text-text-muted font-medium">
                <div className="w-4" />
                <div className="flex-1">Function</div>
                <div className="w-24">Model</div>
                <div className="w-12 text-right">Tokens</div>
                <div className="w-14 text-right">Duration</div>
                <div className="w-14 text-right">Cost</div>
                <div className="w-28">Waterfall</div>
              </div>

              {(() => {
                const startTime = new Date(events[0].timestamp).getTime();
                const endTime = Math.max(
                  ...events.map((e) => new Date(e.timestamp).getTime() + e.duration_ms)
                );
                const totalSpan = Math.max(endTime - startTime, 1);

                return events.map((event, i) => {
                  const fn = event.bl_function ?? "unknown";
                  const provider = event.provider;
                  const eventStart = new Date(event.timestamp).getTime();
                  const offsetPct = ((eventStart - startTime) / totalSpan) * 100;
                  const widthPct = Math.max((event.duration_ms / totalSpan) * 100, 2);

                  return (
                    <div key={event.id} className="flex items-center gap-2 px-1.5 py-1 rounded-sm row-hover">
                      <div className="w-4 flex items-center justify-center shrink-0">
                        <div className="flex flex-col items-center">
                          <div className={`w-px h-1.5 ${i === 0 ? "bg-transparent" : "bg-border-bright"}`} />
                          <Circle size={3} className="text-text-muted fill-current" />
                          <div className={`w-px h-1.5 ${i === events.length - 1 ? "bg-transparent" : "bg-border-bright"}`} />
                        </div>
                      </div>

                      <div className="flex items-center gap-1 flex-1 min-w-0">
                        <ProviderDot provider={provider} />
                        <span className="font-mono text-[11px] text-text-primary truncate">
                          {fn}()
                        </span>
                      </div>

                      <span className="font-mono text-[10px] text-text-muted w-24 truncate shrink-0">
                        {truncateModel(event.model)}
                      </span>

                      <span className="font-mono text-[10px] text-text-muted w-12 text-right shrink-0">
                        {((event.input_tokens ?? 0) + (event.output_tokens ?? 0)).toLocaleString()}
                      </span>

                      <span className="font-mono text-[10px] text-text-secondary w-14 text-right shrink-0">
                        {formatDuration(event.duration_ms)}
                      </span>

                      <span className="font-mono text-[10px] font-medium text-green/80 w-14 text-right shrink-0">
                        ${(event.cost_usd ?? 0).toFixed(4)}
                      </span>

                      <div className="w-28 shrink-0 h-3 relative">
                        <div className="absolute inset-0 bg-surface-overlay rounded-sm" />
                        <div
                          className={`absolute top-0.5 bottom-0.5 rounded-sm ${PROVIDER_BAR_COLORS[provider] ?? "bg-accent/50"}`}
                          style={{
                            left: `${offsetPct}%`,
                            width: `${Math.min(widthPct, 100 - offsetPct)}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                });
              })()}

              <div className="flex items-center gap-2 px-1.5 pt-1.5 mt-0.5 border-t border-border/30">
                <Clock size={10} className="text-text-muted" />
                <span className="font-mono text-[10px] text-text-muted">
                  {new Date(events[0].timestamp).toLocaleTimeString()} — {formatDuration(trace.total_duration_ms)} total
                </span>
                <span className="font-mono text-[10px] text-text-muted ml-auto">
                  {trace.trace_id.slice(0, 16)}...
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TracesView({ traces, loading, projectId, search = "" }: Props) {
  if (loading || !traces) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm">
        <div className="p-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-8 bg-surface-overlay rounded-sm animate-pulse mb-2" />
          ))}
        </div>
      </div>
    );
  }

  const q = search.toLowerCase();
  const filtered = q
    ? traces.filter((t) =>
        (t.trace_name ?? "").toLowerCase().includes(q) ||
        t.trace_id.toLowerCase().includes(q) ||
        t.models.toLowerCase().includes(q) ||
        t.providers.toLowerCase().includes(q)
      )
    : traces;

  return (
    <div className="bg-surface-raised border border-border rounded-sm">
      {/* Column headers */}
      <div className="flex items-center gap-4 px-5 py-3 border-b border-border text-xs uppercase tracking-wider font-medium text-text-muted">
        <div className="w-3" />
        <div className="w-5" />
        <div className="flex-1">Request</div>
        <div className="w-16 text-right">Time</div>
        <div className="w-20 text-right">Duration</div>
        <div className="w-16 text-right">Tokens</div>
        <div className="w-24 text-right">Cost</div>
      </div>

      <div className="max-h-[calc(100vh-220px)] overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-text-muted font-mono">
            {q ? "No matching traces" : "No traces yet"}
          </div>
        )}
        {filtered.map((trace) => (
          <TraceRow key={trace.trace_id} trace={trace} projectId={projectId} />
        ))}
      </div>

      {q && filtered.length > 0 && (
        <div className="px-4 py-2 border-t border-border text-[10px] text-text-muted font-mono">
          {filtered.length} of {traces.length} traces
        </div>
      )}
    </div>
  );
}
