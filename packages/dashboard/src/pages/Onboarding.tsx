import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Copy, Loader2, ExternalLink, Sparkles } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";

export default function Onboarding() {
  const navigate = useNavigate();
  const { projects, loading: authLoading } = useAuth();
  const project = projects[0];
  const projectId = project?.id ?? "";
  const dsn = project ? `https://${project.authKey}@app.costkey.dev/${project.id}` : "";
  const [copied, setCopied] = useState<"dsn" | "ts" | "py" | "cursor" | null>(null);
  const [tab, setTab] = useState<"py" | "ts">("py");
  const [waiting, setWaiting] = useState(true);
  const [eventCount, setEventCount] = useState(0);

  // Poll for first event
  useEffect(() => {
    if (!projectId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/v1/projects/${projectId}/overview`, { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          const count = data.overview?.total_calls ?? 0;
          setEventCount(count);
          if (count > 0) {
            setWaiting(false);
            clearInterval(interval);
          }
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [projectId]);

  const cursorPrompt = `Install the costkey SDK and add costkey.init({ dsn: "${dsn}" }) to my app's entry point file. For Python use: import costkey; costkey.init(dsn="${dsn}"). For TypeScript use: import { CostKey } from 'costkey'; CostKey.init({ dsn: '${dsn}' }).`;

  const copyText = (text: string, key: "dsn" | "ts" | "py" | "cursor") => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const tsSnippet = `npm install costkey

import { CostKey } from 'costkey'

CostKey.init({
  dsn: '${dsn}'
})`;

  const pySnippet = `pip install costkey

import costkey

costkey.init(
  dsn="${dsn}"
)`;

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="w-full max-w-2xl">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <img src="/favicon.svg" alt="CostKey" className="w-8 h-8" />
          <span className="font-mono text-lg font-semibold text-text-primary">CostKey</span>
        </div>

        <div className="bg-surface-raised border border-border rounded-sm p-6">
          {waiting ? (
            <>
              <h1 className="text-xl font-semibold text-text-primary mb-1">Add CostKey to your app</h1>
              <p className="text-sm text-text-secondary mb-6">Paste this into Cursor, Claude Code, or any AI editor. It includes your DSN.</p>

              {/* AI prompt */}
              <div className="relative bg-surface border border-border rounded-sm px-4 py-3 mb-6">
                <p className="font-mono text-xs text-text-secondary leading-relaxed pr-16">
                  Install the costkey SDK and add costkey.init() with my DSN to my app's entry point.
                </p>
                <button
                  onClick={() => copyText(cursorPrompt, "cursor")}
                  className="absolute top-2.5 right-2.5 px-2.5 py-1 text-[10px] font-mono text-text-muted hover:text-text-primary border border-border hover:border-border-bright rounded-sm transition-colors cursor-pointer flex items-center gap-1"
                >
                  {copied === "cursor" ? <><Check size={10} className="text-green" /> Copied</> : <><Copy size={10} /> Copy</>}
                </button>
              </div>

              {/* Code snippets side by side */}
              <div className="grid grid-cols-2 gap-3 mb-6">
                <div className="relative bg-surface border border-border rounded-sm p-3">
                  <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-2">TypeScript</div>
                  <pre className="font-mono text-[11px] text-text-primary leading-relaxed whitespace-pre overflow-x-auto">{tsSnippet}</pre>
                  <button
                    onClick={() => copyText(tsSnippet, "ts")}
                    className="absolute top-2.5 right-2.5 text-text-muted hover:text-text-primary transition-colors cursor-pointer"
                  >
                    {copied === "ts" ? <Check size={12} className="text-green" /> : <Copy size={12} />}
                  </button>
                </div>
                <div className="relative bg-surface border border-border rounded-sm p-3">
                  <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-2">Python</div>
                  <pre className="font-mono text-[11px] text-text-primary leading-relaxed whitespace-pre overflow-x-auto">{pySnippet}</pre>
                  <button
                    onClick={() => copyText(pySnippet, "py")}
                    className="absolute top-2.5 right-2.5 text-text-muted hover:text-text-primary transition-colors cursor-pointer"
                  >
                    {copied === "py" ? <Check size={12} className="text-green" /> : <Copy size={12} />}
                  </button>
                </div>
              </div>

              {/* Step 3: Waiting */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-5 h-5 rounded-full bg-surface-overlay border border-border flex items-center justify-center">
                    <Loader2 size={12} className="text-accent animate-spin" />
                  </div>
                  <span className="text-sm font-medium text-text-primary">Waiting for your first event...</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-3 bg-surface border border-border rounded-sm">
                  <div className="w-2 h-2 rounded-full bg-amber animate-pulse" />
                  <span className="font-mono text-xs text-text-muted">Listening for events on this project...</span>
                </div>
              </div>

              {/* Footer links */}
              <div className="mt-5 pt-4 border-t border-border/50 flex items-center justify-between">
                <a
                  href="https://costkey.dev/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
                >
                  <ExternalLink size={11} />
                  Docs
                </a>
                <button
                  onClick={() => navigate("/")}
                  className="text-xs text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
                >
                  Skip to dashboard &rarr;
                </button>
              </div>
            </>
          ) : (
            /* Events detected -- celebration */
            <div className="text-center py-6 animate-confetti-pop">
              <div className="w-14 h-14 rounded-full bg-green-muted border border-green/30 flex items-center justify-center mx-auto mb-4 relative">
                <Check size={28} className="text-green" />
                {/* Confetti sparkles */}
                <Sparkles size={14} className="text-amber absolute -top-2 -right-2 animate-pulse" />
                <Sparkles size={10} className="text-accent absolute -bottom-1 -left-3 animate-pulse" style={{ animationDelay: "200ms" }} />
                <Sparkles size={12} className="text-cyan absolute -top-1 -left-2 animate-pulse" style={{ animationDelay: "400ms" }} />
              </div>
              <h1 className="text-xl font-semibold text-text-primary mb-2">You're live!</h1>
              <p className="text-sm text-text-secondary mb-1">
                {eventCount} event{eventCount !== 1 ? "s" : ""} received. Your AI costs are being tracked.
              </p>
              <p className="text-xs text-text-muted mb-5">Every API call is now automatically captured.</p>
              <button
                onClick={() => navigate("/")}
                className="bg-accent hover:bg-accent-hover text-black font-mono text-sm font-medium px-8 py-2.5 rounded-sm transition-colors cursor-pointer"
              >
                Open Dashboard &rarr;
              </button>
            </div>
          )}
        </div>

        {waiting && (
          <div></div>
        )}
      </div>
    </div>
  );
}
