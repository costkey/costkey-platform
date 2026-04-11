import { TrendingUp, TrendingDown, Minus, ArrowUp, ArrowDown, AlertTriangle } from "lucide-react";
import type { Summary } from "../hooks/useApi";
import { formatCost, formatTokens } from "../utils";

interface Props {
  summary: Summary | null;
  loading: boolean;
}

function ChangeIndicator({ value, invert = false }: { value: number; invert?: boolean }) {
  const isUp = value > 0;
  const isDown = value < 0;
  const isNeutral = value === 0;

  // For cost: up = bad (amber), down = good (green)
  // invert flips that logic
  const color = isNeutral
    ? "text-text-muted"
    : (isUp && !invert) || (isDown && invert)
      ? "text-amber"
      : "text-green";

  const bgColor = isNeutral
    ? "bg-surface-overlay"
    : (isUp && !invert) || (isDown && invert)
      ? "bg-amber-muted"
      : "bg-green-muted";

  const Icon = isUp ? TrendingUp : isDown ? TrendingDown : Minus;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-medium font-mono ${color} ${bgColor}`}>
      <Icon size={12} />
      {isUp ? "+" : ""}{value.toFixed(1)}%
    </span>
  );
}

function HeadlineSkeleton() {
  return (
    <div className="bg-surface-raised border border-border rounded-sm p-6">
      <div className="h-4 w-48 bg-surface-overlay rounded-sm animate-pulse mb-4" />
      <div className="h-12 w-36 bg-surface-overlay rounded-sm animate-pulse mb-3" />
      <div className="h-4 w-64 bg-surface-overlay rounded-sm animate-pulse" />
    </div>
  );
}

function FeaturesSkeleton() {
  return (
    <div className="bg-surface-raised border border-border rounded-sm p-5">
      <div className="h-4 w-44 bg-surface-overlay rounded-sm animate-pulse mb-5" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 mb-4">
          <div className="h-4 w-32 bg-surface-overlay rounded-sm animate-pulse" />
          <div className="flex-1 h-3 bg-surface-overlay rounded-sm animate-pulse" />
          <div className="h-4 w-16 bg-surface-overlay rounded-sm animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function formatReleaseName(release: string): string {
  // If it looks like a git SHA (40 hex chars or 7+ hex chars), truncate to 7
  if (/^[0-9a-f]{7,40}$/i.test(release)) {
    return release.slice(0, 7);
  }
  // Otherwise show full (semver, tag names, etc.) but cap at 20
  return release.length > 20 ? release.slice(0, 20) + "\u2026" : release;
}

function ReleaseCostChange({ pct }: { pct: number | null }) {
  if (pct === null) {
    return <span className="text-text-muted text-xs font-mono">baseline</span>;
  }
  const isUp = pct > 0;
  const color = isUp ? (pct > 20 ? "text-red" : "text-amber") : "text-green";
  const Icon = isUp ? ArrowUp : ArrowDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-mono ${color}`}>
      <Icon size={11} />
      {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

export default function SummaryView({ summary, loading }: Props) {
  if (loading || !summary) {
    return (
      <div className="flex flex-col gap-5">
        <HeadlineSkeleton />
        <div className="grid grid-cols-[1fr_1fr] gap-5">
          <FeaturesSkeleton />
          <div className="bg-surface-raised border border-border rounded-sm p-5">
            <div className="h-4 w-36 bg-surface-overlay rounded-sm animate-pulse mb-5" />
            <div className="h-20 bg-surface-overlay rounded-sm animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  const maxFeatureCost = summary.topFeatures.length > 0
    ? Math.max(...summary.topFeatures.map((f) => f.cost))
    : 1;

  return (
    <div className="flex flex-col gap-5">
      {/* Top row: spend + deploy side by side */}
      <div className="grid gap-5 grid-cols-[1fr_1fr]">
        {/* Headline card */}
        <div className="animate-in bg-surface-raised border border-border rounded-sm p-5 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-px bg-border-bright" />
          <p className="text-text-muted text-sm font-medium mb-1">
            Your AI spend this month
          </p>
          <div className="flex items-baseline gap-3 mb-1">
            <span className="font-mono text-3xl font-bold tracking-tight text-text-primary">
              {formatCost(summary.thisMonth.cost)}
            </span>
            <ChangeIndicator value={summary.costChange} />
          </div>
          <div className="flex items-center gap-2 text-text-muted text-xs font-mono flex-wrap">
            <span>{formatCost(summary.dailyAvg)}/day avg</span>
            <span className="text-border-bright">·</span>
            <span>projected {formatCost(summary.projectedMonthly)}</span>
            <span className="text-border-bright">·</span>
            <span>{formatTokens(summary.thisMonth.tokens)} tokens</span>
          </div>
        </div>

        {/* Cost by Deploy or Quick Stats */}
        {summary.byRelease && summary.byRelease.length > 0 ? (
        <div className="animate-in bg-surface-raised border border-border rounded-sm p-5" style={{ animationDelay: "30ms" }}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-text-muted text-xs font-medium tracking-wide uppercase">
              Cost by Deploy
            </p>
            {summary.costChangeFromPrevRelease !== null && summary.costChangeFromPrevRelease > 20 && (
              <span className="inline-flex items-center gap-1.5 text-xs text-amber bg-amber-muted px-2 py-0.5 rounded-sm">
                <AlertTriangle size={12} />
                {formatReleaseName(summary.byRelease[0].release)} costs {Math.abs(summary.costChangeFromPrevRelease).toFixed(0)}% more per call than the previous deploy
              </span>
            )}
          </div>
          <table className="w-full">
            <thead>
              <tr className="text-text-muted text-xs uppercase tracking-wide">
                <th className="text-left pb-3 font-medium">Release</th>
                <th className="text-right pb-3 font-medium">Cost</th>
                <th className="text-right pb-3 font-medium">Calls</th>
                <th className="text-right pb-3 font-medium">$/call</th>
                <th className="text-right pb-3 font-medium">Change</th>
              </tr>
            </thead>
            <tbody className="font-mono text-sm">
              {summary.byRelease.map((rel) => (
                <tr key={rel.release} className="border-t border-border">
                  <td className="py-3 text-text-primary" title={rel.release}>{formatReleaseName(rel.release)}</td>
                  <td className="py-3 text-right text-text-primary">{formatCost(rel.cost)}</td>
                  <td className="py-3 text-right text-text-muted">{rel.calls.toLocaleString()}</td>
                  <td className="py-3 text-right text-text-primary">{formatCost(rel.cost_per_call)}/call</td>
                  <td className="py-3 text-right"><ReleaseCostChange pct={rel.cost_change_pct} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        ) : (
        <div className="animate-in bg-surface-raised border border-border rounded-sm p-5" style={{ animationDelay: "30ms" }}>
          <p className="text-text-muted text-xs font-medium tracking-wide uppercase mb-4">
            Quick Stats
          </p>
          <div className="flex flex-col gap-4">
            <div>
              <div className="text-text-muted text-xs mb-1">Avg cost per call</div>
              <div className="font-mono text-2xl font-bold text-text-primary">
                {summary.thisMonth.calls > 0 ? formatCost(summary.thisMonth.cost / summary.thisMonth.calls) : "—"}
              </div>
            </div>
            <div>
              <div className="text-text-muted text-xs mb-1">Total calls</div>
              <div className="font-mono text-2xl font-bold text-text-primary">
                {summary.thisMonth.calls.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-text-muted text-xs mb-1">Total tokens</div>
              <div className="font-mono text-2xl font-bold text-text-primary">
                {formatTokens(summary.thisMonth.tokens)}
              </div>
            </div>
          </div>
        </div>
        )}
      </div>

      <div className="grid grid-cols-[1fr_1fr] gap-5">
        {/* Top cost drivers */}
        <div className="animate-in bg-surface-raised border border-border rounded-sm p-5" style={{ animationDelay: "60ms" }}>
          <p className="text-text-muted text-xs font-medium tracking-wide uppercase mb-4">
            Where your money goes
          </p>
          {summary.topFeatures.length === 0 ? (
            <p className="text-text-muted text-sm">No call site data yet</p>
          ) : (
            <div className="flex flex-col gap-3">
              {summary.topFeatures.map((feature, i) => {
                const barWidth = maxFeatureCost > 0
                  ? (feature.cost / maxFeatureCost) * 100
                  : 0;
                const fnName = feature.function_name || "unknown";

                return (
                  <div key={i} className="flex items-center gap-3">
                    <span className="font-mono text-sm text-text-primary w-40 truncate shrink-0" title={fnName}>
                      {fnName}
                    </span>
                    <div className="flex-1 h-2.5 bg-surface-overlay rounded-sm overflow-hidden">
                      <div
                        className="h-full bg-text-primary/20 rounded-sm cost-bar"
                        style={{ width: `${barWidth}%`, animationDelay: `${i * 80}ms` }}
                      />
                    </div>
                    <span className="font-mono text-sm text-text-primary w-16 text-right shrink-0">
                      {formatCost(feature.cost)}
                    </span>
                    <span className="font-mono text-xs text-text-muted w-12 text-right shrink-0">
                      {feature.pct.toFixed(1)}%
                    </span>
                    <span className="text-xs text-text-muted w-20 text-right shrink-0">
                      {feature.calls.toLocaleString()} calls
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Month comparison */}
        <div className="animate-in bg-surface-raised border border-border rounded-sm p-5" style={{ animationDelay: "120ms" }}>
          <p className="text-text-muted text-xs font-medium tracking-wide uppercase mb-4">
            Month over month
          </p>
          <table className="w-full">
            <thead>
              <tr className="text-text-muted text-xs uppercase tracking-wide">
                <th className="text-left pb-3 font-medium" />
                <th className="text-right pb-3 font-medium">This month</th>
                <th className="text-right pb-3 font-medium">Last month</th>
                <th className="text-right pb-3 font-medium">Change</th>
              </tr>
            </thead>
            <tbody className="font-mono text-sm">
              <tr className="border-t border-border">
                <td className="py-3 text-text-secondary">Cost</td>
                <td className="py-3 text-right text-text-primary">{formatCost(summary.thisMonth.cost)}</td>
                <td className="py-3 text-right text-text-muted">{formatCost(summary.lastMonth.cost)}</td>
                <td className="py-3 text-right">
                  <ChangeIndicator value={summary.costChange} />
                </td>
              </tr>
              <tr className="border-t border-border">
                <td className="py-3 text-text-secondary">Calls</td>
                <td className="py-3 text-right text-text-primary">{summary.thisMonth.calls.toLocaleString()}</td>
                <td className="py-3 text-right text-text-muted">{summary.lastMonth.calls.toLocaleString()}</td>
                <td className="py-3 text-right">
                  <ChangeIndicator value={summary.callsChange} />
                </td>
              </tr>
              <tr className="border-t border-border">
                <td className="py-3 text-text-secondary">Tokens</td>
                <td className="py-3 text-right text-text-primary">{formatTokens(summary.thisMonth.tokens)}</td>
                <td className="py-3 text-right text-text-muted">{formatTokens(summary.lastMonth.tokens)}</td>
                <td className="py-3 text-right">
                  {summary.lastMonth.tokens > 0 ? (
                    <ChangeIndicator
                      value={((summary.thisMonth.tokens - summary.lastMonth.tokens) / summary.lastMonth.tokens) * 100}
                    />
                  ) : (
                    <span className="text-text-muted text-xs">--</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
