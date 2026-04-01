import { useState } from "react";
import { ChevronRight, GitBranch, Circle } from "lucide-react";
import type { Feature } from "../hooks/useApi";

interface Props {
  features: Feature[] | null;
  loading: boolean;
}

function formatCost(cost: number): string {
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
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
    <div className="border-b border-border/40 last:border-b-0">
      {/* Feature header (root function) */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3.5 row-hover cursor-pointer group text-left"
      >
        <ChevronRight
          size={14}
          className={`text-text-muted shrink-0 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
        />

        {/* Root function name */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <GitBranch size={13} className="text-accent shrink-0" />
          <span className="font-mono text-sm font-semibold text-text-primary truncate">
            {feature.rootFunction}()
          </span>
          <span className="font-mono text-[10px] text-text-muted truncate">
            {truncateFile(feature.rootFile)}
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-accent-muted text-accent shrink-0">
            {feature.callSites.length} AI {feature.callSites.length === 1 ? "call" : "calls"}
          </span>
        </div>

        {/* Stats */}
        <span className="font-mono text-xs text-text-secondary w-16 text-right shrink-0">
          {feature.totalCalls.toLocaleString()}
        </span>
        <span className="font-mono text-xs text-text-muted w-20 text-right shrink-0">
          {formatTokens(feature.totalInputTokens + feature.totalOutputTokens)}
        </span>
        <span className="font-mono text-sm font-semibold text-green w-20 text-right shrink-0">
          {formatCost(feature.totalCost)}
        </span>

        {/* Cost proportion bar */}
        <div className="w-24 shrink-0">
          <div className="relative h-2 bg-surface-overlay rounded-sm overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-accent rounded-sm cost-bar"
              style={{ width: `${costPct}%` }}
            />
          </div>
        </div>
      </button>

      {/* Expanded: child call sites */}
      {expanded && (
        <div className="bg-surface/50">
          {feature.callSites.map((cs, i) => {
            const isLast = i === feature.callSites.length - 1;
            const csCostPct = feature.totalCost > 0
              ? (cs.total_cost_usd / feature.totalCost) * 100
              : 0;

            return (
              <div
                key={cs.call_site_key}
                className="flex items-center gap-3 px-4 py-2.5 row-hover"
              >
                {/* Tree connector */}
                <div className="w-3.5 shrink-0" /> {/* chevron spacer */}
                <div className="flex items-center gap-0 shrink-0 text-border-bright">
                  <div className="w-4 flex flex-col items-center">
                    <div className={`w-px ${isLast ? "h-3" : "h-full"} bg-border-bright`} />
                  </div>
                  <div className="w-3 h-px bg-border-bright" />
                  <Circle size={5} className="text-text-muted shrink-0 fill-current" />
                </div>

                {/* Function name */}
                <div className="flex items-center gap-2 flex-1 min-w-0 ml-1">
                  <span className="font-mono text-xs text-text-primary truncate">
                    {cs.function_name ?? "anonymous"}()
                  </span>
                  <span className="font-mono text-[10px] text-text-muted truncate">
                    {truncateFile(cs.file_name)}
                    {cs.line_number != null && `:${cs.line_number}`}
                  </span>
                </div>

                {/* Stats */}
                <span className="font-mono text-[11px] text-text-muted w-16 text-right shrink-0">
                  {cs.total_calls.toLocaleString()}
                </span>
                <span className="font-mono text-[11px] text-text-muted w-20 text-right shrink-0">
                  {formatTokens(cs.total_input_tokens)} in
                </span>
                <span className="font-mono text-xs text-green/80 w-20 text-right shrink-0">
                  {formatCost(cs.total_cost_usd)}
                </span>

                {/* Proportion within feature */}
                <div className="w-24 shrink-0">
                  <div className="relative h-1.5 bg-surface-overlay rounded-sm overflow-hidden">
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

export default function FeatureTree({ features, loading }: Props) {
  if (loading || !features) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm animate-in" style={{ animationDelay: "280ms" }}>
        <div className="p-5">
          <div className="h-4 w-48 bg-surface-overlay rounded-sm animate-pulse mb-4" />
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-14 bg-surface-overlay rounded-sm animate-pulse mb-2" />
          ))}
        </div>
      </div>
    );
  }

  const maxCost = Math.max(...features.map((f) => f.totalCost), 0.001);

  return (
    <div className="bg-surface-raised border border-border rounded-sm animate-in" style={{ animationDelay: "280ms" }}>
      {/* Header */}
      <div className="flex items-center gap-2 p-4 border-b border-border">
        <GitBranch size={14} className="text-accent" />
        <h2 className="text-sm font-medium text-text-secondary tracking-wide uppercase">
          Auto-Detected Features
        </h2>
        <span className="font-mono text-xs text-text-muted ml-auto">
          {features.length} features · {features.reduce((s, f) => s + f.callSites.length, 0)} AI call sites
        </span>
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border/60 text-[11px] uppercase tracking-wider font-medium text-text-muted">
        <div className="flex-1">Feature / Call Site</div>
        <div className="w-16 text-right">Calls</div>
        <div className="w-20 text-right">Tokens</div>
        <div className="w-20 text-right">Cost</div>
        <div className="w-24">Share</div>
      </div>

      {/* Feature rows */}
      {features.map((feature) => (
        <FeatureRow
          key={`${feature.rootFunction}@${feature.rootFile}`}
          feature={feature}
          maxCost={maxCost}
        />
      ))}
    </div>
  );
}
