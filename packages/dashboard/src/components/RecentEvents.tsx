import { Activity } from "lucide-react";
import type { EventRow } from "../hooks/useApi";

interface Props {
  events: EventRow[] | null;
  loading: boolean;
}

const PROVIDER_DOT: Record<string, string> = {
  openai: "bg-green",
  anthropic: "bg-amber",
  google: "bg-cyan",
};

function truncateModel(model: string | null): string {
  if (!model) return "unknown";
  const datePattern = /-\d{4}[-\d]*/;
  return model.replace(datePattern, "").replace(/-$/, "");
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatCost(cost: number | null): string {
  if (cost == null) return "—";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.001) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(6)}`;
}

export default function RecentEvents({ events, loading }: Props) {
  if (loading || !events) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm animate-in" style={{ animationDelay: "420ms" }}>
        <div className="p-4">
          <div className="h-4 w-32 bg-surface-overlay rounded-sm animate-pulse mb-3" />
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-8 bg-surface-overlay rounded-sm animate-pulse mb-1.5" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface-raised border border-border rounded-sm animate-in" style={{ animationDelay: "420ms" }}>
      <div className="flex items-center gap-2 p-4 border-b border-border">
        <Activity size={14} className="text-accent" />
        <h2 className="text-sm font-medium text-text-secondary tracking-wide uppercase">
          Recent Events
        </h2>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-green glow-dot" />
          <span className="text-[11px] text-text-muted font-mono">live</span>
        </div>
      </div>

      <div className="divide-y divide-border/40">
        {events.map((event) => {
          const frames = event.call_site_frames ? JSON.parse(event.call_site_frames) : [];
          const topFrame = frames[0];
          const fnName = topFrame?.functionName ?? null;
          const dotColor = PROVIDER_DOT[event.provider] ?? "bg-text-muted";

          return (
            <div
              key={event.id}
              className="flex items-center gap-3 px-4 py-2.5 row-hover"
            >
              {/* Provider dot */}
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />

              {/* Time */}
              <span className="font-mono text-[11px] text-text-muted w-14 shrink-0">
                {timeAgo(event.timestamp)}
              </span>

              {/* Model */}
              <span className="font-mono text-xs text-text-secondary w-28 truncate shrink-0">
                {truncateModel(event.model)}
              </span>

              {/* Function */}
              <span className="font-mono text-xs text-text-primary truncate flex-1">
                {fnName ? `${fnName}()` : "—"}
              </span>

              {/* Tokens */}
              <span className="font-mono text-[11px] text-text-muted w-20 text-right shrink-0">
                {event.total_tokens?.toLocaleString() ?? "—"} tok
              </span>

              {/* Duration */}
              <span className="font-mono text-[11px] text-text-muted w-16 text-right shrink-0">
                {Math.round(event.duration_ms)}ms
              </span>

              {/* Cost */}
              <span className="font-mono text-xs font-medium text-green w-16 text-right shrink-0">
                {formatCost(event.cost_usd)}
              </span>

              {/* Streaming badge */}
              {event.streaming === 1 && (
                <span className="text-[9px] font-mono px-1 py-0.5 rounded-sm bg-accent-muted text-accent uppercase">
                  sse
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
