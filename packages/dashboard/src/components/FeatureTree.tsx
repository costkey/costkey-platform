import { useState } from "react";
import { ChevronRight, Circle } from "lucide-react";
import type { Feature } from "../hooks/useApi";

interface Props {
  features: Feature[] | null;
  loading: boolean;
  search?: string;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function truncateFile(path: string | null): string {
  if (!path) return "";
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function FeatureRow({ feature, maxCost }: { feature: Feature; maxCost: number }) {
  const [expanded, setExpanded] = useState(true);
  const costPct = (feature.totalCost / maxCost) * 100;

  return (
    <div className="border-b border-border/30 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 row-hover cursor-pointer text-left"
      >
        <ChevronRight
          size={12}
          className={`text-text-muted shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />

        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="font-mono text-xs font-semibold text-text-primary truncate">
            {feature.rootFunction}()
          </span>
          <span className="font-mono text-[10px] text-text-muted truncate">
            {truncateFile(feature.rootFile)}
          </span>
          <span className="text-[9px] font-mono px-1 py-0.5 rounded-sm bg-accent-muted text-accent shrink-0">
            {feature.callSites.length} AI {feature.callSites.length === 1 ? "call" : "calls"}
          </span>
        </div>

        <span className="font-mono text-[11px] text-text-secondary w-12 text-right shrink-0">
          {feature.totalCalls.toLocaleString()}
        </span>
        <span className="font-mono text-[10px] text-text-muted w-14 text-right shrink-0">
          {formatTokens(feature.totalInputTokens + feature.totalOutputTokens)}
        </span>
        <span className="font-mono text-xs font-semibold text-green w-16 text-right shrink-0">
          ${feature.totalCost.toFixed(4)}
        </span>

        <div className="w-20 shrink-0">
          <div className="relative h-1.5 bg-surface-overlay rounded-sm overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-accent rounded-sm cost-bar"
              style={{ width: `${costPct}%` }}
            />
          </div>
        </div>
      </button>

      {expanded && (
        <div className="bg-surface/50">
          {feature.callSites.map((cs, i) => {
            const isLast = i === feature.callSites.length - 1;
            const csCostPct = feature.totalCost > 0
              ? (cs.total_cost_usd / feature.totalCost) * 100
              : 0;

            return (
              <div key={cs.call_site_key} className="flex items-center gap-2 px-3 py-1.5 row-hover">
                <div className="w-3 shrink-0" />
                <div className="flex items-center gap-0 shrink-0 text-border-bright">
                  <div className="w-3 flex flex-col items-center">
                    <div className={`w-px ${isLast ? "h-2" : "h-full"} bg-border-bright`} />
                  </div>
                  <div className="w-2 h-px bg-border-bright" />
                  <Circle size={4} className="text-text-muted shrink-0 fill-current" />
                </div>

                <div className="flex items-center gap-1.5 flex-1 min-w-0 ml-0.5">
                  <span className="font-mono text-[11px] text-text-primary truncate">
                    {cs.function_name ?? "anonymous"}()
                  </span>
                  <span className="font-mono text-[9px] text-text-muted truncate">
                    {truncateFile(cs.file_name)}
                    {cs.line_number != null && `:${cs.line_number}`}
                  </span>
                </div>

                <span className="font-mono text-[10px] text-text-muted w-12 text-right shrink-0">
                  {cs.total_calls.toLocaleString()}
                </span>
                <span className="font-mono text-[10px] text-text-muted w-14 text-right shrink-0">
                  {formatTokens(cs.total_input_tokens)} in
                </span>
                <span className="font-mono text-[11px] text-green/80 w-16 text-right shrink-0">
                  ${cs.total_cost_usd.toFixed(4)}
                </span>

                <div className="w-20 shrink-0">
                  <div className="relative h-1 bg-surface-overlay rounded-sm overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 bg-accent/50 rounded-sm"
                      style={{ width: `${csCostPct}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function FeatureTree({ features, loading, search = "" }: Props) {
  if (loading || !features) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm">
        <div className="p-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-8 bg-surface-overlay rounded-sm animate-pulse mb-1" />
          ))}
        </div>
      </div>
    );
  }

  const q = search.toLowerCase();
  const filtered = q
    ? features.filter((f) =>
        f.rootFunction.toLowerCase().includes(q) ||
        (f.rootFile ?? "").toLowerCase().includes(q) ||
        f.callSites.some((cs) =>
          (cs.function_name ?? "").toLowerCase().includes(q) ||
          (cs.file_name ?? "").toLowerCase().includes(q)
        )
      )
    : features;

  const maxCost = Math.max(...filtered.map((f) => f.totalCost), 0.001);

  return (
    <div className="bg-surface-raised border border-border rounded-sm">
      {/* Column headers */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-[10px] uppercase tracking-wider font-medium text-text-muted">
        <div className="flex-1">Feature / Call Site</div>
        <div className="w-12 text-right">Calls</div>
        <div className="w-14 text-right">Tokens</div>
        <div className="w-16 text-right">Cost</div>
        <div className="w-20">Share</div>
      </div>

      <div className="max-h-[calc(100vh-220px)] overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-text-muted font-mono">
            {q ? "No matching features" : "No features detected yet"}
          </div>
        )}
        {filtered.map((feature) => (
          <FeatureRow
            key={`${feature.rootFunction}@${feature.rootFile}`}
            feature={feature}
            maxCost={maxCost}
          />
        ))}
      </div>

      {q && filtered.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border text-[10px] text-text-muted font-mono">
          {filtered.length} of {features.length} features
        </div>
      )}
    </div>
  );
}
