import type { ModelBreakdown as ModelData } from "../hooks/useApi";
import ProviderLogo from "./ProviderLogo";

interface Props {
  models: ModelData[] | null;
  loading: boolean;
}

function truncateModel(model: string): string {
  return model.replace(/-\d{4}[-\d]*/g, "").replace(/-$/, "");
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

const BAR_COLORS = [
  "bg-accent",
  "bg-green",
  "bg-amber",
  "bg-cyan",
  "bg-violet",
  "bg-rose",
];

export default function ModelBreakdown({ models, loading }: Props) {
  if (loading || !models) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm p-4">
        <div className="h-3 w-28 bg-surface-overlay rounded-sm animate-pulse mb-3" />
        <div className="h-20 bg-surface-overlay rounded-sm animate-pulse" />
      </div>
    );
  }

  const totalCost = models.reduce((sum, m) => sum + m.cost, 0);
  if (totalCost === 0) return null;

  const sorted = [...models].sort((a, b) => b.cost - a.cost);
  const maxCost = sorted[0]?.cost ?? 1;

  return (
    <div className="bg-surface-raised border border-border rounded-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[11px] font-medium text-text-muted tracking-wider uppercase">
          Cost by Model
        </h2>
        <span className="font-mono text-[10px] text-text-muted">
          {sorted.length} models · ${totalCost.toFixed(2)} total
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {sorted.map((model, i) => {
          const pct = (model.cost / totalCost) * 100;
          const barW = (model.cost / maxCost) * 100;
          return (
            <div key={model.model} className="flex items-center gap-2 group">
              <ProviderLogo provider={model.provider} size={12} />
              <span className="font-mono text-[11px] text-text-primary w-44 truncate shrink-0">
                {truncateModel(model.model)}
              </span>
              <span className="font-mono text-[10px] text-text-muted w-16 text-right shrink-0">
                {model.calls.toLocaleString()}
              </span>
              <span className="font-mono text-[10px] text-text-muted w-14 text-right shrink-0">
                {formatTokens(model.input_tokens + model.output_tokens)}
              </span>
              <div className="flex-1 h-3 relative">
                <div className="absolute inset-0 bg-surface-overlay rounded-sm" />
                <div
                  className={`absolute inset-y-0 left-0 rounded-sm ${BAR_COLORS[i % BAR_COLORS.length]} opacity-70 transition-all duration-500`}
                  style={{ width: `${barW}%` }}
                />
              </div>
              <span className="font-mono text-[11px] font-medium text-green w-16 text-right shrink-0">
                ${model.cost.toFixed(2)}
              </span>
              <span className="font-mono text-[9px] text-text-muted w-10 text-right shrink-0">
                {pct.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
