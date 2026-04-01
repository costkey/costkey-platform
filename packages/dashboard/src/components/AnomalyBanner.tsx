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
}

interface Props {
  projectId: string;
}

const TYPE_CONFIG: Record<string, { icon: React.ReactNode; label: string; unit: string; color: string }> = {
  cost_spike: { icon: <TrendingUp size={14} />, label: "Cost spike", unit: "$", color: "text-red" },
  token_spike: { icon: <Zap size={14} />, label: "Token spike", unit: "tok", color: "text-amber" },
  latency_spike: { icon: <Clock size={14} />, label: "Latency spike", unit: "ms", color: "text-amber" },
};

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
  return `${hr}h ago`;
}

export default function AnomalyBanner({ projectId }: Props) {
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fetchAnomalies = async () => {
      try {
        const res = await fetch(`/api/v1/projects/${projectId}/anomalies`, { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setAnomalies(data.anomalies ?? []);
        }
      } catch { /* ignore */ }
    };

    fetchAnomalies();
    const interval = setInterval(fetchAnomalies, 60_000); // Refresh every minute
    return () => clearInterval(interval);
  }, [projectId]);

  const visible = anomalies.filter((a) => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {visible.map((anomaly) => {
        const config = TYPE_CONFIG[anomaly.type] ?? TYPE_CONFIG.cost_spike;
        return (
          <div
            key={anomaly.id}
            className="bg-red-muted border border-red/20 rounded-sm px-4 py-3 flex items-center gap-3 animate-in"
          >
            <AlertTriangle size={16} className="text-red shrink-0" />

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`font-mono text-sm font-semibold ${config.color}`}>
                  {config.label}
                </span>
                <span className="font-mono text-sm text-text-primary">
                  {anomaly.function_name ?? "unknown"}()
                </span>
                <span className="font-mono text-xs text-text-muted">
                  {truncateFile(anomaly.file_name)}
                </span>
              </div>
              <div className="font-mono text-xs text-text-secondary mt-0.5">
                {anomaly.multiplier}x baseline
                <span className="text-text-muted mx-1.5">·</span>
                was {config.unit === "$" ? `$${anomaly.baseline_value.toFixed(4)}` : `${Math.round(anomaly.baseline_value)}${config.unit}`}/call
                <span className="text-text-muted mx-1">→</span>
                now {config.unit === "$" ? `$${anomaly.current_value.toFixed(4)}` : `${Math.round(anomaly.current_value)}${config.unit}`}/call
                <span className="text-text-muted mx-1.5">·</span>
                {timeAgo(anomaly.detected_at)}
              </div>
            </div>

            <button
              onClick={() => setDismissed((prev) => new Set([...prev, anomaly.id]))}
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
