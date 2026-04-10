import { useState } from "react";
import type { EventRow } from "../hooks/useApi";
import ProviderLogo from "./ProviderLogo";
import EventPanel from "./EventPanel";
import { truncateModel, timeAgo, formatDuration, findBusinessFrame, parseFrames, cleanFunctionName } from "../utils";

interface Props {
  events: EventRow[] | null;
  loading: boolean;
  search?: string;
  projectId: string;
}

export default function RecentEvents({ events, loading, search = "", projectId }: Props) {
  const [selectedEvent, setSelectedEvent] = useState<EventRow | null>(null);

  if (loading || !events) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm">
        <div className="p-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-9 bg-surface-overlay rounded-sm animate-pulse mb-2" />
          ))}
        </div>
      </div>
    );
  }

  const q = search.toLowerCase();
  const filtered = q
    ? events.filter((e) => {
        const best = findBusinessFrame(parseFrames(e.call_site_frames));
        const fn = cleanFunctionName(best?.functionName) ?? "";
        return (
          e.model?.toLowerCase().includes(q) ||
          e.provider?.toLowerCase().includes(q) ||
          fn.toLowerCase().includes(q)
        );
      })
    : events;

  return (
    <>
      <div className="bg-surface-raised border border-border rounded-sm">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border text-xs uppercase tracking-wider font-medium text-text-muted">
          <div className="w-5" />
          <div className="w-36">Time</div>
          <div className="w-48">Model</div>
          <div className="flex-1">Function</div>
          <div className="w-20 text-right">Tokens</div>
          <div className="w-20 text-right">Latency</div>
          <div className="w-16 text-right">Cost</div>
        </div>

        <div className="max-h-[calc(100vh-200px)] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-text-muted">
              {q ? "No matching events" : "No events yet"}
            </div>
          )}
          {filtered.map((event) => {
            const frames = parseFrames(event.call_site_frames);
            const best = findBusinessFrame(frames);
            const fnName = cleanFunctionName(best?.functionName);

            return (
              <button
                key={event.id}
                onClick={() => setSelectedEvent(event)}
                className="w-full flex items-center gap-3 px-5 py-3 row-hover row-striped cursor-pointer text-left border-b border-border/20 last:border-b-0"
              >
                <ProviderLogo provider={event.provider} size={14} />

                <div className="font-mono text-xs text-text-muted w-36 shrink-0">
                  <span>{new Date(event.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                  <span className="text-text-muted/50 ml-1">{new Date(event.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                  <span className="text-text-muted/40 ml-1">({timeAgo(event.timestamp)})</span>
                </div>

                <span className="font-mono text-sm text-text-secondary w-48 truncate shrink-0">
                  {truncateModel(event.model)}
                </span>

                <span className="font-mono text-sm text-text-primary truncate flex-1">
                  {fnName ? `${fnName}()` : "—"}
                </span>

                <span className="font-mono text-xs text-text-muted w-20 text-right shrink-0">
                  {event.total_tokens?.toLocaleString() ?? "—"}
                </span>

                <span className="font-mono text-xs text-text-muted w-20 text-right shrink-0">
                  {formatDuration(event.duration_ms)}
                </span>

                <span className="font-mono text-sm font-semibold text-green w-16 text-right shrink-0">
                  ${(event.cost_usd ?? 0).toFixed(4)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {selectedEvent && (
        <EventPanel event={selectedEvent} projectId={projectId} onClose={() => setSelectedEvent(null)} />
      )}
    </>
  );
}
