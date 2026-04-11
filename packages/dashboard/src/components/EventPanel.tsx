import { useState, useEffect } from "react";
import { ArrowDown, ArrowUp, Zap, X, Copy, Check } from "lucide-react";
import type { EventRow } from "../hooks/useApi";
import { getEvent } from "../api";
import ProviderLogo from "./ProviderLogo";
import { truncateModel, formatDuration } from "../utils";

interface Props {
  event: EventRow;
  projectId: string;
  onClose: () => void;
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

function truncateText(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + "…";
}

function safeJsonParse(str: string): unknown {
  try { return JSON.parse(str); } catch { return null; }
}

function extractPrompt(body: unknown): string | null {
  if (!body) return null;
  const b = typeof body === "string" ? safeJsonParse(body) : body;
  if (!b || typeof b !== "object") return null;
  const obj = b as Record<string, unknown>;

  const messages = obj["messages"] as Array<Record<string, unknown>> | undefined;
  if (messages?.length) {
    const last = messages[messages.length - 1];
    const content = last?.["content"];
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content.map((c: Record<string, unknown>) => (typeof c === "string" ? c : c["text"] ?? "")).filter(Boolean).join("\n");
  }

  const contents = obj["contents"] as Array<Record<string, unknown>> | undefined;
  if (contents?.length) {
    const parts = contents[contents.length - 1]?.["parts"] as Array<Record<string, unknown>> | undefined;
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

  // OpenAI format: choices[0].message.content
  const choices = obj["choices"] as Array<Record<string, unknown>> | undefined;
  if (choices?.[0]) {
    const msg = choices[0]["message"] as Record<string, unknown> | undefined;
    if (msg && typeof msg["content"] === "string") return msg["content"];
  }

  // Anthropic format: content[0].text
  const content = obj["content"] as Array<Record<string, unknown>> | undefined;
  if (content && Array.isArray(content))
    return content.map((c) => (typeof c === "object" && c["text"] ? String(c["text"]) : "")).filter(Boolean).join("\n");

  // Google Gemini format: candidates[0].content.parts[0].text
  const candidates = obj["candidates"] as Array<Record<string, unknown>> | undefined;
  if (candidates?.[0]) {
    const cContent = candidates[0]["content"] as Record<string, unknown> | undefined;
    if (cContent) {
      const parts = cContent["parts"] as Array<Record<string, unknown>> | undefined;
      if (parts) return parts.map((p) => (p["text"] ? String(p["text"]) : "")).filter(Boolean).join("\n");
    }
  }

  return null;
}

export default function EventPanel({ event, projectId, onClose }: Props) {
  const [detail, setDetail] = useState<EventRow | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getEvent(projectId, event.id)
      .then((data) => setDetail(data.event))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [event.id, projectId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const frames = event.call_site_frames
    ? (typeof event.call_site_frames === "string" ? JSON.parse(event.call_site_frames) : event.call_site_frames)
    : [];
  const fnName = event.bl_function ?? "unknown";
  const prompt = detail ? extractPrompt(detail.request_body) : null;
  const completion = detail ? extractCompletion(detail.response_body) : null;
  const [copied, setCopied] = useState<"input" | "output" | null>(null);
  const copyText = (text: string, key: "input" | "output") => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40 backdrop-blur-sm" onClick={onClose} />

      <div role="dialog" aria-modal="true" aria-label="Event details" className="fixed top-0 right-0 h-full w-[600px] max-w-[90vw] bg-surface-raised border-l border-border z-50 flex flex-col animate-slide-in">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 panel-header-gradient shrink-0">
          <ProviderLogo provider={event.provider} size={18} />
          <div className="flex-1 min-w-0">
            <div className="font-mono text-base font-semibold text-text-primary truncate">{fnName}()</div>
            <div className="text-xs text-text-muted">{truncateModel(event.model)} · {formatTimestamp(event.timestamp)}</div>
          </div>
          <button onClick={onClose} aria-label="Close panel" className="p-2 text-text-muted hover:text-text-secondary cursor-pointer rounded-sm hover:bg-surface-overlay">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-5">
          {loading && (
            <div className="flex items-center gap-2 py-8 justify-center">
              <div className="w-4 h-4 border-2 border-text-secondary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-text-muted">Loading…</span>
            </div>
          )}

          {!loading && detail && (
            <>
              {/* Stats */}
              <div className="grid grid-cols-3 gap-4">
                <Stat label="Cost" value={`$${(event.cost_usd ?? 0).toFixed(4)}`} accent />
                <Stat label="Duration" value={formatDuration(event.duration_ms)} />
                <Stat label="Status" value={`${event.status_code ?? "—"}`} />
              </div>

              {/* Tokens */}
              <div className="bg-surface border border-border rounded-sm p-4">
                <div className="text-xs uppercase tracking-wider text-text-muted font-medium mb-3">Tokens</div>
                <div className="grid grid-cols-3 gap-4">
                  <TokenBlock icon={<ArrowUp size={12} />} label="Input" value={event.input_tokens} color="text-cyan" />
                  <TokenBlock icon={<ArrowDown size={12} />} label="Output" value={event.output_tokens} color="text-green" />
                  <TokenBlock icon={<Zap size={12} />} label="Total" value={event.total_tokens} color="text-text-primary" />
                </div>
                {event.streaming && (
                  <div className="grid grid-cols-2 gap-4 mt-3 pt-3 border-t border-border/50">
                    <Stat label="TTFT" value={event.ttft ? formatDuration(event.ttft) : "—"} />
                    <Stat label="Tokens/sec" value={event.tps ? Math.round(event.tps).toLocaleString() : "—"} />
                  </div>
                )}
              </div>

              {/* Input */}
              {prompt && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <ArrowUp size={12} className="text-cyan" />
                      <span className="text-xs uppercase tracking-wider font-medium text-text-muted">Input</span>
                    </div>
                    <button onClick={() => copyText(prompt, "input")} className="flex items-center gap-1 text-[10px] font-mono text-text-muted hover:text-text-primary transition-colors cursor-pointer">
                      {copied === "input" ? <><Check size={10} className="text-green" /> Copied</> : <><Copy size={10} /> Copy</>}
                    </button>
                  </div>
                  <pre className="bg-surface border border-border rounded-sm px-4 py-3 font-mono text-xs text-text-secondary whitespace-pre-wrap break-words max-h-72 overflow-y-auto leading-relaxed">
                    {truncateText(prompt, 3000)}
                  </pre>
                </div>
              )}

              {/* Output */}
              {completion && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <ArrowDown size={12} className="text-green" />
                      <span className="text-xs uppercase tracking-wider font-medium text-text-muted">Output</span>
                    </div>
                    <button onClick={() => copyText(completion, "output")} className="flex items-center gap-1 text-[10px] font-mono text-text-muted hover:text-text-primary transition-colors cursor-pointer">
                      {copied === "output" ? <><Check size={10} className="text-green" /> Copied</> : <><Copy size={10} /> Copy</>}
                    </button>
                  </div>
                  <pre className="bg-surface border border-border rounded-sm px-4 py-3 font-mono text-xs text-text-secondary whitespace-pre-wrap break-words max-h-72 overflow-y-auto leading-relaxed">
                    {truncateText(completion, 3000)}
                  </pre>
                </div>
              )}

              {/* Stack trace */}
              {frames.length > 0 && (
                <div>
                  <span className="text-xs uppercase tracking-wider font-medium text-text-muted">Call Site</span>
                  <div className="bg-surface border border-border rounded-sm px-4 py-3 mt-2">
                    {frames.slice(0, 8).map((frame: { functionName: string | null; fileName: string | null; lineNumber: number | null }, i: number) => (
                      <div key={i} className="font-mono text-xs py-0.5">
                        <span className="text-text-primary">{frame.functionName ?? "anonymous"}</span>
                        <span className="text-text-muted"> at </span>
                        <span className="text-text-muted">{frame.fileName ?? "?"}</span>
                        {frame.lineNumber && <span className="text-text-secondary">:{frame.lineNumber}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div className="border-t border-border/50 pt-4">
                <div className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Request</div>
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Method" value={event.method ?? "POST"} />
                  <Stat label="Streaming" value={event.streaming ? "Yes (SSE)" : "No"} />
                </div>
                <div className="font-mono text-xs text-text-muted mt-2 truncate" title={event.url}>{event.url}</div>
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-2 border-t border-border/50 shrink-0">
          <span className="font-mono text-[10px] text-text-muted/50">{event.id}</span>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted/70 mb-0.5">{label}</div>
      <div className={`font-mono text-base ${accent ? "text-green font-bold" : "text-text-primary"}`}>{value}</div>
    </div>
  );
}

function TokenBlock({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number | null; color: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 mb-0.5">
        <span className={color}>{icon}</span>
        <span className="text-[10px] uppercase tracking-wider text-text-muted/70">{label}</span>
      </div>
      <div className="font-mono text-base text-text-primary">{value?.toLocaleString() ?? "—"}</div>
    </div>
  );
}
