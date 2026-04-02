import { useState } from "react";
import { ChevronRight, ArrowDown, ArrowUp, Zap } from "lucide-react";
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

  // OpenAI / Anthropic messages format
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

  // Google format
  const contents = obj["contents"] as Array<Record<string, unknown>> | undefined;
  if (contents && Array.isArray(contents)) {
    const last = contents[contents.length - 1];
    const parts = last?.["parts"] as Array<Record<string, unknown>> | undefined;
    if (parts) return parts.map((p) => p["text"] ?? "").filter(Boolean).join("\n");
  }

  // Fallback: prompt field
  if (typeof obj["prompt"] === "string") return obj["prompt"];

  return null;
}

function extractCompletion(body: unknown): string | null {
  if (!body) return null;
  const b = typeof body === "string" ? safeJsonParse(body) : body;
  if (!b || typeof b !== "object") return null;
  const obj = b as Record<string, unknown>;

  // OpenAI format
  const choices = obj["choices"] as Array<Record<string, unknown>> | undefined;
  if (choices?.[0]) {
    const message = choices[0]["message"] as Record<string, unknown> | undefined;
    if (message && typeof message["content"] === "string") return message["content"];
    const delta = choices[0]["delta"] as Record<string, unknown> | undefined;
    if (delta && typeof delta["content"] === "string") return delta["content"];
  }

  // Anthropic format
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

function EventDetailRow({ event, projectId }: { event: EventRow; projectId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<EventRow | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const frames = event.call_site_frames
    ? (typeof event.call_site_frames === "string" ? JSON.parse(event.call_site_frames) : event.call_site_frames)
    : [];
  const fnName = frames[0]?.functionName ?? null;

  async function toggle() {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (!detail) {
      setLoadingDetail(true);
      try {
        const data = await getEvent(projectId, event.id);
        setDetail(data.event);
      } catch { /* silent */ }
      setLoadingDetail(false);
    }
  }

  const prompt = detail ? extractPrompt(detail.request_body) : null;
  const completion = detail ? extractCompletion(detail.response_body) : null;

  return (
    <div className="border-b border-border/30 last:border-b-0">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-3 px-3 py-2 row-hover cursor-pointer text-left"
      >
        <ChevronRight
          size={11}
          className={`text-text-muted shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />

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
          <span className="text-[8px] font-mono px-1 py-0.5 rounded-sm bg-accent-muted text-accent uppercase w-8 text-center shrink-0">
            sse
          </span>
        ) : (
          <span className="w-8 shrink-0" />
        )}
      </button>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="bg-surface/60 border-t border-border/20 px-3 py-3">
          {loadingDetail && (
            <div className="flex items-center gap-2 py-2">
              <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />
              <span className="text-[10px] text-text-muted font-mono">Loading event details...</span>
            </div>
          )}

          {detail && (
            <div className="flex flex-col gap-3">
              {/* Metadata grid */}
              <div className="grid grid-cols-6 gap-3">
                <MetaStat label="Timestamp" value={formatTimestamp(event.timestamp)} />
                <MetaStat label="Provider" value={event.provider} />
                <MetaStat label="Model" value={event.model ?? "unknown"} />
                <MetaStat label="Status" value={String(event.status_code ?? "—")} />
                <MetaStat label="Duration" value={`${Math.round(event.duration_ms)}ms`} />
                <MetaStat label="Cost" value={`$${(event.cost_usd ?? 0).toFixed(2)}`} accent />
              </div>

              {/* Token breakdown */}
              <div className="grid grid-cols-6 gap-3">
                <TokenStat icon={<ArrowUp size={10} />} label="Input" value={event.input_tokens} />
                <TokenStat icon={<ArrowDown size={10} />} label="Output" value={event.output_tokens} />
                <TokenStat icon={<Zap size={10} />} label="Total" value={event.total_tokens} />
                {event.streaming && (
                  <>
                    <MetaStat label="TTFT" value={event.ttft ? `${Math.round(event.ttft)}ms` : "—"} />
                    <MetaStat label="TPS" value={event.tps ? `${Math.round(event.tps)}` : "—"} />
                  </>
                )}
                {!event.streaming && (
                  <MetaStat label="Streaming" value="No" />
                )}
              </div>

              {/* Input prompt */}
              {prompt && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <ArrowUp size={10} className="text-cyan" />
                    <span className="text-[10px] uppercase tracking-wider font-medium text-text-muted">Input</span>
                  </div>
                  <pre className="bg-surface-raised border border-border rounded-sm px-3 py-2 font-mono text-[11px] text-text-secondary whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed">
                    {truncateText(prompt, 2000)}
                  </pre>
                </div>
              )}

              {/* Output completion */}
              {completion && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <ArrowDown size={10} className="text-green" />
                    <span className="text-[10px] uppercase tracking-wider font-medium text-text-muted">Output</span>
                  </div>
                  <pre className="bg-surface-raised border border-border rounded-sm px-3 py-2 font-mono text-[11px] text-text-secondary whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed">
                    {truncateText(completion, 2000)}
                  </pre>
                </div>
              )}

              {/* Call site frames */}
              {frames.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider font-medium text-text-muted">Stack Trace</span>
                  <div className="bg-surface-raised border border-border rounded-sm px-3 py-2">
                    {frames.slice(0, 5).map((frame: { functionName: string | null; fileName: string | null; lineNumber: number | null }, i: number) => (
                      <div key={i} className="font-mono text-[10px] text-text-muted py-0.5">
                        <span className="text-text-secondary">{frame.functionName ?? "anonymous"}</span>
                        <span className="text-text-muted/60"> at </span>
                        <span className="text-text-muted">{frame.fileName ?? "?"}</span>
                        {frame.lineNumber && <span className="text-accent">:{frame.lineNumber}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Context / trace info */}
              {event.context && (
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider font-medium text-text-muted">Context</span>
                  <pre className="bg-surface-raised border border-border rounded-sm px-3 py-2 font-mono text-[10px] text-text-muted whitespace-pre-wrap">
                    {JSON.stringify(typeof event.context === "string" ? safeJsonParse(event.context) : event.context, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetaStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wider text-text-muted/70">{label}</span>
      <span className={`font-mono text-[11px] truncate ${accent ? "text-green font-medium" : "text-text-secondary"}`}>
        {value}
      </span>
    </div>
  );
}

function TokenStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <span className="text-text-muted">{icon}</span>
        <span className="text-[9px] uppercase tracking-wider text-text-muted/70">{label}</span>
      </div>
      <span className="font-mono text-[11px] text-text-secondary">
        {value?.toLocaleString() ?? "—"}
      </span>
    </div>
  );
}

export default function RecentEvents({ events, loading, search = "", projectId }: Props) {
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
        <div className="w-3" />
        <div className="w-4" />
        <div className="w-10">Time</div>
        <div className="w-28">Model</div>
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
        {filtered.map((event) => (
          <EventDetailRow key={event.id} event={event} projectId={projectId} />
        ))}
      </div>

      {q && filtered.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border text-[10px] text-text-muted font-mono">
          {filtered.length} of {events.length} events
        </div>
      )}
    </div>
  );
}
