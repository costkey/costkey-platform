import { useState, useEffect } from "react";
import { AlertTriangle, X, TrendingUp, Clock, Zap } from "lucide-react";

interface Anomaly {
  id: string;
  function_name: string | null;
  file_name: string | null;
  type: string;
  baseline_value: number;
  current_value: number;
  multiplier: number;
  detected_at: string;
  first_detected_at: string | null;
  occurrence_count: number;
}

interface Props {
  projectId: string;
}

const TYPE_CONFIG: Record<string, { icon: React.ReactNode; label: string; unit: string; color: string }> = {
  cost_spike: { icon: <TrendingUp size={14} />, label: "Cost spike", unit: "$", color: "text-red" },
  token_spike: { icon: <Zap size={14} />, label: "Token spike", unit: "tok", color: "text-amber" },
  latency_spike: { icon: <Clock size={14} />, label: "Latency spike", unit: "ms", color: "text-amber" },
};

// One visible row per (function, file, type). If the server accidentally
// gives us duplicates (old rows from pre-dedup days), collapse them client-side.
interface GroupedAnomaly {
  // The representative anomaly (most recent in the group)
  rep: Anomaly;
  // All the ids that belong to this group (for a single dismiss call to nuke them all)
  ids: string[];
  // Count across the group
  totalOccurrences: number;
}

function groupKey(a: Anomaly): string {
  return `${a.type}::${a.function_name ?? ""}::${a.file_name ?? ""}`;
}

function groupAnomalies(rows: Anomaly[]): GroupedAnomaly[] {
  const byKey = new Map<string, GroupedAnomaly>();
  for (const a of rows) {
    const k = groupKey(a);
    const existing = byKey.get(k);
    if (!existing) {
      byKey.set(k, { rep: a, ids: [a.id], totalOccurrences: a.occurrence_count || 1 });
    } else {
      existing.ids.push(a.id);
      existing.totalOccurrences += a.occurrence_count || 1;
      // Keep the most recent as the representative
      if (new Date(a.detected_at).getTime() > new Date(existing.rep.detected_at).getTime()) {
        existing.rep = a;
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) => new Date(b.rep.detected_at).getTime() - new Date(a.rep.detected_at).getTime(),
  );
}

function truncateFile(path: string | null): string {
  if (!path) return "";
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export default function AnomalyBanner({ projectId }: Props) {
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  // Optimistic local dismiss set — hides immediately while the server call flies.
  // We still call the server so the dismiss persists across refreshes.
  const [pending, setPending] = useState<Set<string>>(new Set());

  const fetchAnomalies = async () => {
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/anomalies`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setAnomalies(data.anomalies ?? []);
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    fetchAnomalies();
    const interval = setInterval(fetchAnomalies, 60_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const dismiss = async (ids: string[]) => {
    // Optimistic hide
    setPending((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    // Persist — dismiss all ids in the group server-side
    try {
      await Promise.all(
        ids.map((id) =>
          fetch(`/api/v1/projects/${projectId}/anomalies/${id}/dismiss`, {
            method: "POST",
            credentials: "include",
          }),
        ),
      );
      // Refetch so state reflects server truth
      void fetchAnomalies();
    } catch {
      // Rollback optimistic hide on failure
      setPending((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  };

  const groups = groupAnomalies(anomalies.filter((a) => !pending.has(a.id)));
  if (groups.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {groups.map((g) => {
        const a = g.rep;
        const config = TYPE_CONFIG[a.type] ?? TYPE_CONFIG.cost_spike;
        const firstSeen = a.first_detected_at ?? a.detected_at;
        return (
          <div
            key={groupKey(a)}
            className="bg-red-muted border border-red/20 rounded-sm px-4 py-3 flex items-center gap-3 animate-in"
          >
            <AlertTriangle size={16} className="text-red shrink-0" />

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`font-mono text-sm font-semibold ${config.color}`}>
                  {config.label}
                </span>
                <span className="font-mono text-sm text-text-primary">
                  {a.function_name ?? "unknown"}()
                </span>
                <span className="font-mono text-xs text-text-muted">
                  {truncateFile(a.file_name)}
                </span>
                {g.totalOccurrences > 1 && (
                  <span className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-red/15 text-red">
                    ×{g.totalOccurrences}
                  </span>
                )}
              </div>
              <div className="font-mono text-xs text-text-secondary mt-0.5">
                {a.multiplier}x baseline
                <span className="text-text-muted mx-1.5">·</span>
                was {config.unit === "$" ? `$${a.baseline_value.toFixed(4)}` : `${Math.round(a.baseline_value)}${config.unit}`}/call
                <span className="text-text-muted mx-1">→</span>
                now {config.unit === "$" ? `$${a.current_value.toFixed(4)}` : `${Math.round(a.current_value)}${config.unit}`}/call
                <span className="text-text-muted mx-1.5">·</span>
                {g.totalOccurrences > 1
                  ? `first seen ${timeAgo(firstSeen)}, last ${timeAgo(a.detected_at)}`
                  : timeAgo(a.detected_at)}
              </div>
            </div>

            <button
              onClick={() => void dismiss(g.ids)}
              title="Dismiss. Reappears only if the anomaly gets materially worse."
              className="shrink-0 text-text-muted hover:text-text-secondary cursor-pointer p-1"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
