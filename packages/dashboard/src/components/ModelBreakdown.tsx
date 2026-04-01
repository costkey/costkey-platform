import type { ModelBreakdown as ModelData } from "../hooks/useApi";

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

function formatCost(cost: number): string {
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}

function truncateModel(model: string): string {
  // "claude-sonnet-4-0-20250514" → "claude-sonnet-4"
  // "gpt-4o-2024-11-20" → "gpt-4o"
  const datePattern = /-\d{4}[-\d]*/;
  return model.replace(datePattern, "").replace(/-$/, "");
}

export default function ModelBreakdown({ models, loading }: Props) {
  if (loading || !models) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm p-5 animate-in" style={{ animationDelay: "360ms" }}>
        <div className="h-4 w-36 bg-surface-overlay rounded-sm animate-pulse mb-4" />
        <div className="h-32 bg-surface-overlay rounded-sm animate-pulse" />
      </div>
    );
  }

  const totalCost = models.reduce((sum, m) => sum + m.cost, 0);
  if (totalCost === 0) return null;

  const sorted = [...models].sort((a, b) => b.cost - a.cost);

  return (
    <div className="bg-surface-raised border border-border rounded-sm p-5 animate-in" style={{ animationDelay: "360ms" }}>
      <h2 className="text-sm font-medium text-text-secondary tracking-wide uppercase mb-4">
        Cost by Model
      </h2>

      {/* Stacked bar */}
      <div className="flex h-3 rounded-sm overflow-hidden mb-5 gap-px">
        {sorted.map((model, i) => {
          const pct = (model.cost / totalCost) * 100;
          const color = MODEL_COLORS[i % MODEL_COLORS.length];
          return (
            <div
              key={model.model}
              className={`${color.bar} transition-all duration-300`}
              style={{ width: `${Math.max(pct, 0.5)}%`, opacity: 0.85 }}
              title={`${truncateModel(model.model)}: ${formatCost(model.cost)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-col gap-2.5">
        {sorted.map((model, i) => {
          const pct = (model.cost / totalCost) * 100;
          const color = MODEL_COLORS[i % MODEL_COLORS.length];
          return (
            <div key={model.model} className="flex items-center gap-3">
              <div
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: color.dot }}
              />
              <span className="font-mono text-xs text-text-primary truncate flex-1">
                {truncateModel(model.model)}
              </span>
              <span className="font-mono text-xs text-text-muted">
                {model.calls.toLocaleString()} calls
              </span>
              <span className={`font-mono text-xs font-medium ${color.text}`}>
                {formatCost(model.cost)}
              </span>
              <span className="font-mono text-[10px] text-text-muted w-10 text-right">
                {pct.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
