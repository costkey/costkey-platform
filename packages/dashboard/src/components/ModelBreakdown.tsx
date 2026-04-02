import type { ModelBreakdown as ModelData } from "../hooks/useApi";
import ProviderLogo from "./ProviderLogo";

interface Props {
  models: ModelData[] | null;
  loading: boolean;
}

const MODEL_COLORS = [
  { bar: "bg-accent", text: "text-accent", dot: "#6366f1" },
  { bar: "bg-green", text: "text-green", dot: "#34d399" },
  { bar: "bg-amber", text: "text-amber", dot: "#fbbf24" },
  { bar: "bg-cyan", text: "text-cyan", dot: "#22d3ee" },
  { bar: "bg-violet", text: "text-violet", dot: "#a78bfa" },
  { bar: "bg-rose", text: "text-rose", dot: "#fb7185" },
];

function truncateModel(model: string): string {
  return model.replace(/-\d{4}[-\d]*/g, "").replace(/-$/, "");
}

export default function ModelBreakdown({ models, loading }: Props) {
  if (loading || !models) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm p-4">
        <div className="h-3 w-28 bg-surface-overlay rounded-sm animate-pulse mb-3" />
        <div className="h-32 bg-surface-overlay rounded-sm animate-pulse" />
      </div>
    );
  }

  const totalCost = models.reduce((sum, m) => sum + m.cost, 0);
  if (totalCost === 0) return null;

  const sorted = [...models].sort((a, b) => b.cost - a.cost);

  return (
    <div className="bg-surface-raised border border-border rounded-sm p-4">
      <h2 className="text-[11px] font-medium text-text-muted tracking-wider uppercase mb-3">
        Cost by Model
      </h2>

      {/* Stacked bar */}
      <div className="flex h-2.5 rounded-sm overflow-hidden mb-4 gap-px">
        {sorted.map((model, i) => {
          const pct = (model.cost / totalCost) * 100;
          const color = MODEL_COLORS[i % MODEL_COLORS.length];
          return (
            <div
              key={model.model}
              className={`${color.bar} transition-all duration-300`}
              style={{ width: `${Math.max(pct, 0.5)}%`, opacity: 0.85 }}
              title={`${truncateModel(model.model)}: $${model.cost.toFixed(2)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-col gap-2">
        {sorted.map((model, i) => {
          const pct = (model.cost / totalCost) * 100;
          const color = MODEL_COLORS[i % MODEL_COLORS.length];
          return (
            <div key={model.model} className="flex items-center gap-2">
              <ProviderLogo provider={model.provider} size={12} />
              <span className="font-mono text-[11px] text-text-primary truncate flex-1">
                {truncateModel(model.model)}
              </span>
              <span className="font-mono text-[10px] text-text-muted">
                {model.calls.toLocaleString()}
              </span>
              <span className={`font-mono text-[11px] font-medium ${color.text}`}>
                ${model.cost.toFixed(2)}
              </span>
              <span className="font-mono text-[10px] text-text-muted w-9 text-right">
                {pct.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
