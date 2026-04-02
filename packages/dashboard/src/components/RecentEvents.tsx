import type { EventRow } from "../hooks/useApi";
import ProviderLogo from "./ProviderLogo";

interface Props {
  events: EventRow[] | null;
  loading: boolean;
  search?: string;
}

function truncateModel(model: string | null): string {
  if (!model) return "unknown";
  return model.replace(/-\d{4}[-\d]*/g, "").replace(/-$/, "");
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default function RecentEvents({ events, loading, search = "" }: Props) {
  if (loading || !events) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm">
        <div className="p-3">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-7 bg-surface-overlay rounded-sm animate-pulse mb-1" />
          ))}
        </div>
      </div>
    );
  }

  const q = search.toLowerCase();
  const filtered = q
    ? events.filter((e) => {
        const frames = e.call_site_frames
          ? (typeof e.call_site_frames === "string" ? JSON.parse(e.call_site_frames) : e.call_site_frames)
          : [];
        const fn = frames[0]?.functionName ?? "";
        return (
          e.model?.toLowerCase().includes(q) ||
          e.provider?.toLowerCase().includes(q) ||
          fn.toLowerCase().includes(q)
        );
      })
    : events;

  return (
    <div className="bg-surface-raised border border-border rounded-sm">
      {/* Header row */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border text-[10px] uppercase tracking-wider font-medium text-text-muted">
        <div className="w-4" />
        <div className="w-10">Time</div>
        <div className="w-28">Model</div>
        <div className="flex-1">Function</div>
        <div className="w-16 text-right">Tokens</div>
        <div className="w-14 text-right">Latency</div>
        <div className="w-14 text-right">Cost</div>
        <div className="w-8" />
      </div>

      <div className="max-h-[calc(100vh-220px)] overflow-y-auto divide-y divide-border/30">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-text-muted font-mono">
            {q ? "No matching events" : "No events yet"}
          </div>
        )}
        {filtered.map((event) => {
          const frames = event.call_site_frames
            ? (typeof event.call_site_frames === "string" ? JSON.parse(event.call_site_frames) : event.call_site_frames)
            : [];
          const fnName = frames[0]?.functionName ?? null;

          return (
            <div key={event.id} className="flex items-center gap-3 px-3 py-1.5 row-hover">
              <ProviderLogo provider={event.provider} size={13} />

              <span className="font-mono text-[10px] text-text-muted w-10 shrink-0">
                {timeAgo(event.timestamp)}
              </span>

              <span className="font-mono text-[11px] text-text-secondary w-28 truncate shrink-0">
                {truncateModel(event.model)}
              </span>

              <span className="font-mono text-[11px] text-text-primary truncate flex-1">
                {fnName ? `${fnName}()` : "—"}
              </span>

              <span className="font-mono text-[10px] text-text-muted w-16 text-right shrink-0">
                {event.total_tokens?.toLocaleString() ?? "—"}
              </span>

              <span className="font-mono text-[10px] text-text-muted w-14 text-right shrink-0">
                {Math.round(event.duration_ms)}ms
              </span>

              <span className="font-mono text-[11px] font-medium text-green w-14 text-right shrink-0">
                ${(event.cost_usd ?? 0).toFixed(2)}
              </span>

              {event.streaming ? (
                <span className="text-[8px] font-mono px-1 py-0.5 rounded-sm bg-accent-muted text-accent uppercase w-8 text-center">
                  sse
                </span>
              ) : (
                <span className="w-8" />
              )}
            </div>
          );
        })}
      </div>

      {q && filtered.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border text-[10px] text-text-muted font-mono">
          {filtered.length} of {events.length} events
        </div>
      )}
    </div>
  );
}
