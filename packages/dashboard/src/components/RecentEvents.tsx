import { useState, useEffect } from "react";
import { ArrowDown, ArrowUp, Zap, X } from "lucide-react";
import type { EventRow } from "../hooks/useApi";
import { getEvent } from "../api";
import ProviderLogo from "./ProviderLogo";

interface Props {
  events: EventRow[] | null;
  loading: boolean;
  search?: string;
  projectId: string;
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

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

function extractPrompt(body: unknown): string | null {
  if (!body) return null;
  const b = typeof body === "string" ? safeJsonParse(body) : body;
  if (!b || typeof b !== "object") return null;
  const obj = b as Record<string, unknown>;

  const messages = obj["messages"] as Array<Record<string, unknown>> | undefined;
  if (messages && Array.isArray(messages)) {
    const last = messages[messages.length - 1];
    if (last) {
      const content = last["content"];
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((c: Record<string, unknown>) => (typeof c === "string" ? c : c["text"] ?? ""))
          .filter(Boolean)
          .join("\n");
      }
    }
  }

  const contents = obj["contents"] as Array<Record<string, unknown>> | undefined;
  if (contents && Array.isArray(contents)) {
    const last = contents[contents.length - 1];
    const parts = last?.["parts"] as Array<Record<string, unknown>> | undefined;
    if (parts) return parts.map((p) => p["text"] ?? "").filter(Boolean).join("\n");
  }

  if (typeof obj["prompt"] === "string") return obj["prompt"];
  return null;
}

function extractCompletion(body: unknown): string | null {
  if (!body) return null;
  const b = typeof body === "string" ? safeJsonParse(body) : body;
  if (!b || typeof b !== "object") return null;
  const obj = b as Record<string, unknown>;

  const choices = obj["choices"] as Array<Record<string, unknown>> | undefined;
  if (choices?.[0]) {
    const message = choices[0]["message"] as Record<string, unknown> | undefined;
    if (message && typeof message["content"] === "string") return message["content"];
  }

  const content = obj["content"] as Array<Record<string, unknown>> | undefined;
  if (content && Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "object" && c["text"] ? String(c["text"]) : ""))
      .filter(Boolean)
      .join("\n");
  }

  return null;
}

function safeJsonParse(str: string): unknown {
  try { return JSON.parse(str); } catch { return null; }
}

// ── Slide-over panel ──

function EventPanel({ event, projectId, onClose }: { event: EventRow; projectId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<EventRow | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getEvent(projectId, event.id)
      .then((data) => setDetail(data.event))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [event.id, projectId]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const frames = event.call_site_frames
    ? (typeof event.call_site_frames === "string" ? JSON.parse(event.call_site_frames) : event.call_site_frames)
    : [];
  const fnName = frames[0]?.functionName ?? "unknown";

  const prompt = detail ? extractPrompt(detail.request_body) : null;
  const completion = detail ? extractCompletion(detail.response_body) : null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-[560px] max-w-[90vw] bg-surface-raised border-l border-border z-50 flex flex-col animate-slide-in">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border shrink-0">
          <ProviderLogo provider={event.provider} size={16} />
          <div className="flex-1 min-w-0">
            <div className="font-mono text-sm font-medium text-text-primary truncate">
              {fnName}()
            </div>
            <div className="font-mono text-[10px] text-text-muted">
              {truncateModel(event.model)} · {formatTimestamp(event.timestamp)}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-text-muted hover:text-text-secondary cursor-pointer rounded-sm hover:bg-surface-overlay transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {loading && (
            <div className="flex items-center gap-2 py-8 justify-center">
              <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-text-muted font-mono">Loading...</span>
            </div>
          )}

          {!loading && detail && (
            <>
              {/* Stats grid */}
              <div className="grid grid-cols-3 gap-3">
                <PanelStat label="Cost" value={`$${(event.cost_usd ?? 0).toFixed(2)}`} accent />
                <PanelStat label="Duration" value={`${Math.round(event.duration_ms)}ms`} />
                <PanelStat label="Status" value={`${event.status_code ?? "—"}`} />
              </div>

              {/* Token breakdown */}
              <div className="bg-surface border border-border rounded-sm p-3">
                <div className="text-[10px] uppercase tracking-wider text-text-muted font-medium mb-2">Tokens</div>
                <div className="grid grid-cols-3 gap-3">
                  <TokenBlock icon={<ArrowUp size={11} />} label="Input" value={event.input_tokens} color="text-cyan" />
                  <TokenBlock icon={<ArrowDown size={11} />} label="Output" value={event.output_tokens} color="text-green" />
                  <TokenBlock icon={<Zap size={11} />} label="Total" value={event.total_tokens} color="text-accent" />
                </div>
                {event.streaming && (
                  <div className="grid grid-cols-2 gap-3 mt-2 pt-2 border-t border-border/50">
                    <PanelStat label="TTFT" value={event.ttft ? `${Math.round(event.ttft)}ms` : "—"} />
                    <PanelStat label="Tokens/sec" value={event.tps ? `${Math.round(event.tps)}` : "—"} />
                  </div>
                )}
              </div>

              {/* Input prompt */}
              {prompt && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <ArrowUp size={11} className="text-cyan" />
                    <span className="text-[10px] uppercase tracking-wider font-medium text-text-muted">Input</span>
                  </div>
                  <pre className="bg-surface border border-border rounded-sm px-3 py-2.5 font-mono text-[11px] text-text-secondary whitespace-pre-wrap break-words max-h-64 overflow-y-auto leading-relaxed">
                    {truncateText(prompt, 3000)}
                  </pre>
                </div>
              )}

              {/* Output */}
              {completion && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <ArrowDown size={11} className="text-green" />
                    <span className="text-[10px] uppercase tracking-wider font-medium text-text-muted">Output</span>
                  </div>
                  <pre className="bg-surface border border-border rounded-sm px-3 py-2.5 font-mono text-[11px] text-text-secondary whitespace-pre-wrap break-words max-h-64 overflow-y-auto leading-relaxed">
                    {truncateText(completion, 3000)}
                  </pre>
                </div>
              )}

              {/* Stack trace */}
              {frames.length > 0 && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider font-medium text-text-muted">Call Site</span>
                  <div className="bg-surface border border-border rounded-sm px-3 py-2.5 mt-1.5">
                    {frames.slice(0, 8).map((frame: { functionName: string | null; fileName: string | null; lineNumber: number | null }, i: number) => (
                      <div key={i} className="font-mono text-[11px] py-0.5">
                        <span className="text-text-primary">{frame.functionName ?? "anonymous"}</span>
                        <span className="text-text-muted"> at </span>
                        <span className="text-text-muted">{frame.fileName ?? "?"}</span>
                        {frame.lineNumber && <span className="text-accent">:{frame.lineNumber}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Context */}
              {event.context && Object.keys(typeof event.context === "string" ? safeJsonParse(event.context) as object ?? {} : event.context).length > 0 && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider font-medium text-text-muted">Context</span>
                  <pre className="bg-surface border border-border rounded-sm px-3 py-2.5 mt-1.5 font-mono text-[10px] text-text-muted whitespace-pre-wrap">
                    {JSON.stringify(typeof event.context === "string" ? safeJsonParse(event.context) : event.context, null, 2)}
                  </pre>
                </div>
              )}

              {/* Metadata */}
              <div className="border-t border-border/50 pt-3">
                <div className="text-[10px] uppercase tracking-wider text-text-muted font-medium mb-2">Request</div>
                <div className="grid grid-cols-2 gap-2">
                  <PanelStat label="Method" value={event.method ?? "POST"} />
                  <PanelStat label="Streaming" value={event.streaming ? "Yes (SSE)" : "No"} />
                </div>
                <div className="font-mono text-[10px] text-text-muted mt-2 truncate" title={event.url}>
                  {event.url}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2 border-t border-border/50 shrink-0">
          <span className="font-mono text-[9px] text-text-muted/50">{event.id}</span>
        </div>
      </div>
    </>
  );
}

function PanelStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-text-muted/70 mb-0.5">{label}</div>
      <div className={`font-mono text-sm ${accent ? "text-green font-semibold" : "text-text-primary"}`}>{value}</div>
    </div>
  );
}

function TokenBlock({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number | null; color: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 mb-0.5">
        <span className={color}>{icon}</span>
        <span className="text-[9px] uppercase tracking-wider text-text-muted/70">{label}</span>
      </div>
      <div className="font-mono text-sm text-text-primary">{value?.toLocaleString() ?? "—"}</div>
    </div>
  );
}

// ── Main component ──

export default function RecentEvents({ events, loading, search = "", projectId }: Props) {
  const [selectedEvent, setSelectedEvent] = useState<EventRow | null>(null);

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
    <>
      <div className="bg-surface-raised border border-border rounded-sm">
        {/* Header row */}
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border text-[10px] uppercase tracking-wider font-medium text-text-muted">
          <div className="w-4" />
          <div className="w-10">Time</div>
          <div className="w-40">Model</div>
          <div className="flex-1">Function</div>
          <div className="w-16 text-right">Tokens</div>
          <div className="w-14 text-right">Latency</div>
          <div className="w-14 text-right">Cost</div>
          <div className="w-8" />
        </div>

        <div className="max-h-[calc(100vh-200px)] overflow-y-auto">
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
              <button
                key={event.id}
                onClick={() => setSelectedEvent(event)}
                className="w-full flex items-center gap-3 px-3 py-2 row-hover cursor-pointer text-left border-b border-border/20 last:border-b-0"
              >
                <ProviderLogo provider={event.provider} size={13} />

                <span className="font-mono text-[10px] text-text-muted w-10 shrink-0">
                  {timeAgo(event.timestamp)}
                </span>

                <span className="font-mono text-[11px] text-text-secondary w-40 truncate shrink-0">
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
                  <span className="text-[8px] font-mono px-1 py-0.5 rounded-sm bg-accent-muted text-accent uppercase w-8 text-center shrink-0">
                    sse
                  </span>
                ) : (
                  <span className="w-8 shrink-0" />
                )}
              </button>
            );
          })}
        </div>

        {q && filtered.length > 0 && (
          <div className="px-3 py-1.5 border-t border-border text-[10px] text-text-muted font-mono">
            {filtered.length} of {events.length} events
          </div>
        )}
      </div>

      {/* Slide-over panel */}
      {selectedEvent && (
        <EventPanel
          event={selectedEvent}
          projectId={projectId}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </>
  );
}
