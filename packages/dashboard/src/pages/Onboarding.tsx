import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Check, Copy, Loader2, ExternalLink, Sparkles } from "lucide-react";

export default function Onboarding() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const dsn = params.get("dsn") ?? "";
  const projectId = params.get("project") ?? "";
  const [copied, setCopied] = useState<"dsn" | "ts" | "py" | null>(null);
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

  const copyText = (text: string, key: "dsn" | "ts" | "py") => {
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
      <div className="w-full max-w-lg">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <img src="/favicon.svg" alt="CostKey" className="w-8 h-8" />
          <span className="font-mono text-lg font-semibold text-text-primary">CostKey</span>
        </div>

        <div className="bg-surface-raised border border-border rounded-sm p-6">
          {waiting ? (
            <>
              <h1 className="text-xl font-semibold text-text-primary mb-2">You're almost there</h1>
              <p className="text-sm text-text-secondary mb-6">Add CostKey to your app. Every AI call will be tracked automatically.</p>

              {/* Step 1: DSN */}
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-5 h-5 rounded-full bg-accent flex items-center justify-center text-black text-xs font-mono font-bold">1</div>
                  <span className="text-sm font-medium text-text-primary">Your DSN</span>
                </div>
                <div className="flex items-center gap-2 bg-surface border border-border rounded-sm px-3 py-2.5">
                  <code className="font-mono text-xs text-accent flex-1 truncate select-all">{dsn}</code>
                  <button
                    onClick={() => copyText(dsn, "dsn")}
                    className="shrink-0 text-text-muted hover:text-accent transition-colors cursor-pointer"
                  >
                    {copied === "dsn" ? <Check size={14} className="text-green" /> : <Copy size={14} />}
                  </button>
                </div>
              </div>

              {/* Step 2: Install */}
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-5 h-5 rounded-full bg-accent flex items-center justify-center text-black text-xs font-mono font-bold">2</div>
                  <span className="text-sm font-medium text-text-primary">Add to your app</span>
                </div>

                <div className="flex gap-0 mb-0">
                  <button
                    onClick={() => setTab("py")}
                    className={`px-4 py-2 text-xs font-mono border border-border cursor-pointer transition-colors rounded-tl-sm ${
                      tab === "py" ? "bg-surface-overlay text-accent border-b-surface-overlay" : "bg-surface text-text-muted"
                    }`}
                  >Python</button>
                  <button
                    onClick={() => setTab("ts")}
                    className={`px-4 py-2 text-xs font-mono border border-border cursor-pointer transition-colors rounded-tr-sm ${
                      tab === "ts" ? "bg-surface-overlay text-accent border-b-surface-overlay" : "bg-surface text-text-muted"
                    }`}
                  >TypeScript</button>
                </div>

                <div className="relative bg-surface-overlay border border-border border-t-0 rounded-b-sm p-4">
                  <pre className="font-mono text-xs text-text-primary leading-relaxed whitespace-pre overflow-x-auto">
                    {tab === "ts" ? tsSnippet : pySnippet}
                  </pre>
                  <button
                    onClick={() => copyText(tab === "ts" ? tsSnippet : pySnippet, tab)}
                    className="absolute top-3 right-3 text-text-muted hover:text-accent transition-colors cursor-pointer"
                  >
                    {copied === tab ? <Check size={14} className="text-green" /> : <Copy size={14} />}
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

              {/* Docs link */}
              <div className="mt-5 pt-4 border-t border-border/50">
                <a
                  href="https://costkey.dev/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-text-muted hover:text-accent transition-colors"
                >
                  <ExternalLink size={11} />
                  More setup options in the docs
                </a>
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
          <button
            onClick={() => navigate("/")}
            className="block w-full text-center text-sm text-text-muted mt-4 hover:text-text-secondary transition-colors cursor-pointer"
          >
            Skip -- go to dashboard
          </button>
        )}
      </div>
    </div>
  );
}
