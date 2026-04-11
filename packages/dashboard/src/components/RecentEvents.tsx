import { useState } from "react";
import type { EventRow } from "../hooks/useApi";
import ProviderLogo from "./ProviderLogo";
import EventPanel from "./EventPanel";
import { truncateModel, timeAgo, formatDuration, cleanFunctionName } from "../utils";

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
        const fn = e.bl_function ?? "";
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
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wider font-medium text-text-muted">
              <th className="text-left px-5 py-3 w-[3%]" />
              <th className="text-left px-2 py-3 w-[18%]">Time</th>
              <th className="text-left px-2 py-3 w-[18%]">Model</th>
              <th className="text-left px-2 py-3">Function</th>
              <th className="text-right px-2 py-3 w-[10%]">Tokens</th>
              <th className="text-right px-2 py-3 w-[10%]">Latency</th>
              <th className="text-right px-5 py-3 w-[10%]">Cost</th>
            </tr>
          </thead>
        </table>

        <div className="max-h-[calc(100vh-220px)] overflow-y-auto">
          <table className="w-full">
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-text-muted">
                    {q ? "No matching events" : "No events yet"}
                  </td>
                </tr>
              )}
              {filtered.map((event) => {
                const fnName = event.bl_function;

                return (
                  <tr
                    key={event.id}
                    onClick={() => setSelectedEvent(event)}
                    className="row-hover row-striped cursor-pointer border-b border-border/10 last:border-b-0"
                  >
                    <td className="px-5 py-3 w-[3%]">
                      <ProviderLogo provider={event.provider} size={20} />
                    </td>
                    <td className="px-2 py-3 w-[18%]">
                      <span className="font-mono text-xs text-text-muted">
                        {new Date(event.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        <span className="text-text-muted/50 ml-1">{new Date(event.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                        <span className="text-text-muted/40 ml-1">({timeAgo(event.timestamp)})</span>
                      </span>
                    </td>
                    <td className="px-2 py-3 w-[18%]">
                      <span className="font-mono text-sm text-text-secondary truncate block">
                        {truncateModel(event.model)}
                      </span>
                    </td>
                    <td className="px-2 py-3">
                      <span className="font-mono text-sm text-text-primary truncate block">
                        {fnName ? `${fnName}()` : "—"}
                      </span>
                    </td>
                    <td className="px-2 py-3 w-[10%] text-right">
                      <span className="font-mono text-xs text-text-muted">
                        {event.total_tokens?.toLocaleString() ?? "—"}
                      </span>
                    </td>
                    <td className="px-2 py-3 w-[10%] text-right">
                      <span className="font-mono text-xs text-text-muted">
                        {formatDuration(event.duration_ms)}
                      </span>
                    </td>
                    <td className="px-5 py-3 w-[10%] text-right">
                      <span className="font-mono text-sm font-semibold text-green">
                        ${(event.cost_usd ?? 0).toFixed(4)}
                      </span>
                    </td>
                  </tr>
                );
              })}
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
