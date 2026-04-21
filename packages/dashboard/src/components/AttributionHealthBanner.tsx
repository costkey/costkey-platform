import { useEffect, useState } from "react";
import { Info, X, ExternalLink } from "lucide-react";

interface Props { projectId: string }

interface Health {
  windowHours: number;
  totals: {
    total: number;
    attributed: number;
    unattributed: number;
    noFrames: number;
    attributionRate: number;
  };
  unattributedBreakdown: {
    bundledNextjs: number;
    bundledWebpack: number;
    withFramesButUnattributed: number;
    noFrames: number;
  };
  sourcemaps: { uploaded: number; latestAt: string | null };
  primaryCause: "ok" | "bundled_needs_sourcemaps" | "no_frames" | "mixed";
  suggestion: string | null;
}

const DISMISS_KEY = "ck_attrhealth_dismissed_at";

export default function AttributionHealthBanner({ projectId }: Props) {
  const [health, setHealth] = useState<Health | null>(null);
  const [dismissedRecently, setDismissedRecently] = useState(false);

  useEffect(() => {
    // Check if user dismissed recently (last 24h) — use localStorage so this
    // doesn't reset every page load but also doesn't hide forever.
    try {
      const ts = localStorage.getItem(`${DISMISS_KEY}_${projectId}`);
      if (ts && Date.now() - parseInt(ts, 10) < 24 * 60 * 60 * 1000) {
        setDismissedRecently(true);
      }
    } catch { /* no-op */ }

    const load = async () => {
      try {
        const r = await fetch(`/api/v1/projects/${projectId}/attribution-health`, { credentials: "include" });
        if (r.ok) setHealth(await r.json() as Health);
      } catch { /* no-op */ }
    };
    void load();
    const interval = setInterval(load, 5 * 60_000);
    return () => clearInterval(interval);
  }, [projectId]);

  const dismiss = () => {
    try { localStorage.setItem(`${DISMISS_KEY}_${projectId}`, String(Date.now())); } catch { /* no-op */ }
    setDismissedRecently(true);
  };

  if (!health || dismissedRecently) return null;
  if (health.primaryCause === "ok") return null;
  // Don't nag for tiny datasets — stats are meaningless under ~20 events
  if (health.totals.total < 20) return null;

  const pct = Math.round((1 - health.totals.attributionRate) * 100);

  // Different color / severity by cause
  const critical = health.primaryCause === "no_frames";
  const borderClass = critical ? "border-red/30 bg-red/5" : "border-amber/30 bg-amber/5";
  const iconClass = critical ? "text-red" : "text-amber";

  return (
    <div className={`border ${borderClass} rounded-sm px-4 py-3 flex items-start gap-3`}>
      <Info size={16} className={`${iconClass} shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-sm text-text-primary">
            {pct}% of recent AI calls ({health.totals.unattributed} of {health.totals.total}) couldn't be attributed to a function
          </span>
          <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">
            last {health.windowHours}h
          </span>
        </div>
        {health.suggestion && (
          <p className="font-mono text-xs text-text-secondary mt-1 leading-relaxed">
            {health.suggestion}
          </p>
        )}
        <div className="flex items-center gap-4 mt-2 font-mono text-[11px] text-text-muted">
          {health.unattributedBreakdown.bundledNextjs > 0 && (
            <span>{health.unattributedBreakdown.bundledNextjs} in Next.js bundles</span>
          )}
          {health.unattributedBreakdown.bundledWebpack > 0 && (
            <span>{health.unattributedBreakdown.bundledWebpack} in webpack chunks</span>
          )}
          {health.unattributedBreakdown.noFrames > 0 && (
            <span>{health.unattributedBreakdown.noFrames} with empty stacks</span>
          )}
          {health.sourcemaps.uploaded > 0 && (
            <span className="text-text-secondary">{health.sourcemaps.uploaded} sourcemaps uploaded</span>
          )}
        </div>
        {health.primaryCause === "bundled_needs_sourcemaps" && (
          <a
            href="https://docs.costkey.dev/sourcemaps"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-2 font-mono text-xs text-accent hover:text-accent-hover"
          >
            How to upload sourcemaps <ExternalLink size={10} />
          </a>
        )}
      </div>
      <button
        onClick={dismiss}
        title="Dismiss for 24 hours"
        className="shrink-0 text-text-muted hover:text-text-secondary cursor-pointer p-1"
      >
        <X size={14} />
      </button>
    </div>
  );
}
