import { useState } from "react";
import { ChevronRight, Route, Clock, Circle } from "lucide-react";
import type { Trace } from "../hooks/useApi";
import { getTrace, type TraceEvent } from "../api";

interface Props {
  traces: Trace[] | null;
  loading: boolean;
  projectId: string;
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: "bg-green",
  anthropic: "bg-amber",
  google: "bg-cyan",
};

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(6)}`;
}

function truncateModel(model: string): string {
  return model.replace(/-\d{4}[-\d]*/g, "").replace(/-$/, "");
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function TraceRow({ trace, projectId }: { trace: Trace; projectId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<TraceEvent[] | null>(null);
  const [loading, setLoading] = useState(false);

  const models = trace.models.split(",").map((m) => truncateModel(m.trim()));
  const providers = trace.providers.split(",");

  async function toggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!events) {
      setLoading(true);
      try {
        const data = await getTrace(projectId, trace.trace_id);
        setEvents(data.events);
      } catch {
        // silent
      }
      setLoading(false);
    }
  }

  return (
    <div className="border-b border-border/40 last:border-b-0">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-3 px-4 py-3 row-hover cursor-pointer text-left"
      >
        <ChevronRight
          size={13}
          className={`text-text-muted shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />

        {/* Provider dots */}
        <div className="flex gap-1 shrink-0">
          {providers.map((p, i) => (
            <div key={i} className={`w-2 h-2 rounded-full ${PROVIDER_COLORS[p.trim()] ?? "bg-text-muted"}`} />
          ))}
        </div>

        {/* Trace name */}
        <span className="font-mono text-sm font-medium text-text-primary truncate min-w-0">
          {trace.trace_name ?? trace.trace_id}
        </span>

        {/* Call count badge */}
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-surface-overlay text-text-secondary shrink-0">
          {trace.call_count} {trace.call_count === 1 ? "call" : "calls"}
        </span>

        {/* Models */}
        <span className="font-mono text-[11px] text-text-muted truncate flex-1 min-w-0">
          {models.join(", ")}
        </span>

        {/* Time ago */}
        <span className="font-mono text-[11px] text-text-muted w-10 text-right shrink-0">
          {timeAgo(trace.started_at)}
        </span>

        {/* Duration */}
        <span className="font-mono text-[11px] text-text-muted w-16 text-right shrink-0">
          {Math.round(trace.total_duration_ms)}ms
        </span>

        {/* Tokens */}
        <span className="font-mono text-[11px] text-text-muted w-16 text-right shrink-0">
          {((trace.total_input_tokens + trace.total_output_tokens) / 1000).toFixed(1)}k
        </span>

        {/* Cost */}
        <span className="font-mono text-xs font-semibold text-green w-20 text-right shrink-0">
          {formatCost(trace.total_cost)}
        </span>
      </button>

      {/* Expanded: trace events waterfall */}
      {expanded && (
        <div className="bg-surface/50 px-4 py-2 pb-3">
          {loading && (
            <div className="flex items-center gap-2 py-2">
              <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-text-muted">Loading trace...</span>
            </div>
          )}
          {events && events.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {/* Waterfall header */}
              <div className="flex items-center gap-2 px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-muted font-medium">
                <div className="w-5" /> {/* connector space */}
                <div className="flex-1">Function</div>
                <div className="w-28">Model</div>
                <div className="w-14 text-right">Tokens</div>
                <div className="w-16 text-right">Duration</div>
                <div className="w-16 text-right">Cost</div>
                <div className="w-32">Waterfall</div>
              </div>

              {(() => {
                // Calculate waterfall timings
                const startTime = new Date(events[0].timestamp).getTime();
                const endTime = Math.max(
                  ...events.map((e) => new Date(e.timestamp).getTime() + e.duration_ms)
                );
                const totalSpan = Math.max(endTime - startTime, 1);

                return events.map((event, i) => {
                  const frames = event.call_site_frames
                    ? JSON.parse(event.call_site_frames)
                    : [];
                  const fn = frames[0]?.functionName ?? "unknown";
                  const provider = event.provider;
                  const dotColor = PROVIDER_COLORS[provider] ?? "bg-text-muted";

                  const eventStart = new Date(event.timestamp).getTime();
                  const offsetPct = ((eventStart - startTime) / totalSpan) * 100;
                  const widthPct = Math.max((event.duration_ms / totalSpan) * 100, 2);

                  const barColors: Record<string, string> = {
                    openai: "bg-green/70",
                    anthropic: "bg-amber/70",
                    google: "bg-cyan/70",
                  };

                  return (
                    <div
                      key={event.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-sm row-hover"
                    >
                      {/* Tree connector */}
                      <div className="w-5 flex items-center justify-center shrink-0">
                        <div className="flex flex-col items-center">
                          <div className={`w-px h-2 ${i === 0 ? "bg-transparent" : "bg-border-bright"}`} />
                          <Circle size={4} className="text-text-muted fill-current" />
                          <div className={`w-px h-2 ${i === events.length - 1 ? "bg-transparent" : "bg-border-bright"}`} />
                        </div>
                      </div>

                      {/* Function */}
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
                        <span className="font-mono text-xs text-text-primary truncate">
                          {fn}()
                        </span>
                      </div>

                      {/* Model */}
                      <span className="font-mono text-[11px] text-text-muted w-28 truncate shrink-0">
                        {truncateModel(event.model)}
                      </span>

                      {/* Tokens */}
                      <span className="font-mono text-[11px] text-text-muted w-14 text-right shrink-0">
                        {((event.input_tokens ?? 0) + (event.output_tokens ?? 0)).toLocaleString()}
                      </span>

                      {/* Duration */}
                      <span className="font-mono text-[11px] text-text-secondary w-16 text-right shrink-0">
                        {Math.round(event.duration_ms)}ms
                      </span>

                      {/* Cost */}
                      <span className="font-mono text-[11px] font-medium text-green/80 w-16 text-right shrink-0">
                        {formatCost(event.cost_usd ?? 0)}
                      </span>

                      {/* Waterfall bar */}
                      <div className="w-32 shrink-0 h-4 relative">
                        <div className="absolute inset-0 bg-surface-overlay rounded-sm" />
                        <div
                          className={`absolute top-0.5 bottom-0.5 rounded-sm ${barColors[provider] ?? "bg-accent/50"}`}
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

              {/* Trace summary line */}
              <div className="flex items-center gap-2 px-2 pt-2 mt-1 border-t border-border/30">
                <Clock size={11} className="text-text-muted" />
                <span className="font-mono text-[11px] text-text-muted">
                  {new Date(events[0].timestamp).toLocaleTimeString()} — {Math.round(trace.total_duration_ms)}ms total
                </span>
                <span className="font-mono text-[11px] text-text-muted ml-auto">
                  trace: {trace.trace_id.slice(0, 16)}...
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TracesView({ traces, loading, projectId }: Props) {
  if (loading || !traces) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm animate-in" style={{ animationDelay: "360ms" }}>
        <div className="p-5">
          <div className="h-4 w-32 bg-surface-overlay rounded-sm animate-pulse mb-4" />
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-10 bg-surface-overlay rounded-sm animate-pulse mb-2" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface-raised border border-border rounded-sm animate-in" style={{ animationDelay: "360ms" }}>
      <div className="flex items-center gap-2 p-4 border-b border-border">
        <Route size={14} className="text-accent" />
        <h2 className="text-sm font-medium text-text-secondary tracking-wide uppercase">
          Traces
        </h2>
        <span className="font-mono text-xs text-text-muted ml-auto">
          {traces.length} recent traces
        </span>
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border/60 text-[10px] uppercase tracking-wider font-medium text-text-muted">
        <div className="w-3" /> {/* chevron */}
        <div className="w-5" /> {/* dots */}
        <div className="flex-1">Request</div>
        <div className="w-10 text-right">Time</div>
        <div className="w-16 text-right">Duration</div>
        <div className="w-16 text-right">Tokens</div>
        <div className="w-20 text-right">Cost</div>
      </div>

      <div className="max-h-[500px] overflow-y-auto">
        {traces.map((trace) => (
          <TraceRow key={trace.trace_id} trace={trace} projectId={projectId} />
        ))}
      </div>
    </div>
  );
}
