import type { ModelBreakdown as ModelData } from "../hooks/useApi";
import ProviderLogo from "./ProviderLogo";
import { truncateModel } from "../utils";

interface Props {
  models: ModelData[] | null;
  loading: boolean;
}

const BAR_COLORS = ["bg-accent", "bg-green", "bg-amber", "bg-cyan", "bg-violet", "bg-rose"];

export default function ModelBreakdown({ models, loading }: Props) {
  if (loading || !models) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm p-5">
        <div className="h-4 w-28 bg-surface-overlay rounded-sm animate-pulse mb-4" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-6 bg-surface-overlay rounded-sm animate-pulse mb-2" />
        ))}
      </div>
    );
  }

  const totalCost = models.reduce((sum, m) => sum + m.cost, 0);
  if (totalCost === 0) return null;

  const sorted = [...models].sort((a, b) => b.cost - a.cost);
  const maxCost = sorted[0]?.cost ?? 1;

  return (
    <div className="bg-surface-raised border border-border rounded-sm p-5">
      <h2 className="text-xs font-semibold text-text-secondary tracking-wide uppercase mb-4">
        Cost by Model
      </h2>

      <div className="flex flex-col gap-2.5">
        {sorted.map((model, i) => {
          const barW = (model.cost / maxCost) * 100;
          return (
            <div key={model.model}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <ProviderLogo provider={model.provider} size={13} />
                  <span className="font-mono text-xs text-text-primary truncate">
                    {truncateModel(model.model)}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="font-mono text-xs text-text-muted">
                    {model.calls.toLocaleString()}
                  </span>
                  <span className="font-mono text-xs font-semibold text-green w-16 text-right">
                    ${model.cost.toFixed(4)}
                  </span>
                </div>
              </div>
              <div className="h-2 bg-surface-overlay rounded-sm overflow-hidden">
                <div
                  className={`h-full rounded-sm ${BAR_COLORS[i % BAR_COLORS.length]} opacity-70 transition-all duration-500`}
                  style={{ width: `${barW}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
