import { useState, useEffect, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { TrendingUp, TrendingDown, Minus, FolderTree, Tag, Flame, LayoutGrid } from "lucide-react";
import { getInsights, type InsightsData, type TimeRange } from "../api";
import { formatCost, formatTokens, truncateFile } from "../utils";
import CostTreemap from "./CostTreemap";

interface Props {
  projectId: string;
}

const RANGES: { id: TimeRange; label: string }[] = [
  { id: "7d", label: "7D" },
  { id: "mtd", label: "MTD" },
  { id: "30d", label: "30D" },
  { id: "3m", label: "3M" },
  { id: "6m", label: "6M" },
  { id: "1y", label: "1Y" },
];

const MODULE_COLORS = [
  "#34d399", "#22d3ee", "#fbbf24", "#a78bfa", "#fb7185",
];

function ChangeIndicator({ change }: { change: number | null | undefined }) {
  if (change == null || typeof change !== "number" || !isFinite(change)) {
    return <span className="text-text-muted text-[10px]">new</span>;
  }
  if (Math.abs(change) < 1) return <Minus size={12} className="text-text-muted" />;
  if (change > 0) return (
    <span className="flex items-center gap-0.5 text-red text-xs font-mono">
      <TrendingUp size={12} />+{change.toFixed(0)}%
    </span>
  );
  return (
    <span className="flex items-center gap-0.5 text-green text-xs font-mono">
      <TrendingDown size={12} />{change.toFixed(0)}%
    </span>
  );
}

function CostBar({ cost, maxCost }: { cost: number; maxCost: number }) {
  const pct = maxCost > 0 ? (cost / maxCost) * 100 : 0;
  return (
    <div className="w-full bg-surface rounded-full h-2 overflow-hidden">
      <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function InsightsView({ projectId }: Props) {
  const [data, setData] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<TimeRange>("30d");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getInsights(projectId, range);
      setData(result);
    } catch { /* ignore */ }
    setLoading(false);
  }, [projectId, range]);

  useEffect(() => { void load(); }, [load]);

  // Build chart data from module trends
  const chartData = data ? buildChartData(data) : [];
  const contextKeys = data ? Object.keys(data.context) : [];
  const maxModuleCost = data?.modules?.[0]?.cost ?? 0;

  if (loading && !data) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 bg-surface-raised rounded w-48" />
        <div className="h-64 bg-surface-raised rounded" />
        <div className="h-48 bg-surface-raised rounded" />
      </div>
    );
  }

  if (!data || (data.totals.calls === 0)) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted text-sm font-mono">
        No data for this period. Send some AI calls first.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Time range selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-mono font-semibold text-text-primary uppercase tracking-wider">Insights</h2>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={`px-2.5 py-1 text-[11px] font-mono rounded-sm transition-colors cursor-pointer ${
                range === r.id
                  ? "bg-accent text-black font-semibold"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Cost treemap — drillable from module → function */}
      {data.modules.length > 0 && data.totals.cost > 0 && (
        <CostTreemap data={data} projectId={projectId} />
      )}

      {/* Module cost breakdown + trend chart side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Module breakdown */}
        <div className="bg-surface-raised border border-border rounded-sm p-4">
          <div className="flex items-center gap-2 mb-4">
            <FolderTree size={14} className="text-text-muted" />
            <h3 className="text-xs font-mono font-semibold text-text-primary uppercase tracking-wider">Cost by Module</h3>
          </div>
          <div className="space-y-3">
            {data.modules.slice(0, 8).map((mod) => {
              const pct = data.totals.cost > 0 ? ((mod.cost / data.totals.cost) * 100).toFixed(1) : "0";
              return (
                <div key={mod.module}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-text-secondary truncate max-w-[60%]" title={mod.module}>
                      {mod.module === "(unknown)" ? "(unknown)" : truncateFile(mod.module.replace(/\/$/, ""))}
                    </span>
                    <span className="text-xs font-mono text-text-primary">{formatCost(mod.cost)} <span className="text-text-muted">({pct}%)</span></span>
                  </div>
                  <CostBar cost={mod.cost} maxCost={maxModuleCost} />
                  <div className="flex gap-3 mt-1">
                    <span className="text-[10px] font-mono text-text-muted">{mod.calls.toLocaleString()} calls</span>
                    <span className="text-[10px] font-mono text-text-muted">{mod.functions} functions</span>
                    <span className="text-[10px] font-mono text-text-muted">{formatTokens(mod.tokens)} tokens</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Module trend chart */}
        <div className="bg-surface-raised border border-border rounded-sm p-4">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp size={14} className="text-text-muted" />
            <h3 className="text-xs font-mono font-semibold text-text-primary uppercase tracking-wider">Module Trends</h3>
          </div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 10, fontFamily: "JetBrains Mono", fill: "var(--color-text-muted)" }}
                  tickFormatter={(v: string) => new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                />
                <YAxis
                  tick={{ fontSize: 10, fontFamily: "JetBrains Mono", fill: "var(--color-text-muted)" }}
                  tickFormatter={(v: number) => formatCost(v)}
                  width={50}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-surface-raised)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "4px",
                    fontFamily: "JetBrains Mono",
                    fontSize: "11px",
                  }}
                  formatter={(value: number, name: string) => [formatCost(value), truncateFile(name.replace(/\/$/, ""))]}
                  labelFormatter={(label: string) => new Date(label).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                />
                {data.modules.slice(0, 5).map((mod, i) => (
                  <Bar
                    key={mod.module}
                    dataKey={mod.module}
                    stackId="modules"
                    fill={MODULE_COLORS[i % MODULE_COLORS.length]}
                    radius={i === data.modules.slice(0, 5).length - 1 ? [2, 2, 0, 0] : undefined}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-60 text-text-muted text-xs font-mono">
              Not enough data for trend chart
            </div>
          )}
        </div>
      </div>

      {/* Function hotspots */}
      <div className="bg-surface-raised border border-border rounded-sm p-4">
        <div className="flex items-center gap-2 mb-4">
          <Flame size={14} className="text-text-muted" />
          <h3 className="text-xs font-mono font-semibold text-text-primary uppercase tracking-wider">Function Hotspots</h3>
          <span className="text-[10px] font-mono text-text-muted ml-auto">vs previous period</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-text-muted text-left">
                <th className="pb-2 pr-4 font-medium">Function</th>
                <th className="pb-2 pr-4 font-medium text-right">Cost</th>
                <th className="pb-2 pr-4 font-medium text-right">Calls</th>
                <th className="pb-2 pr-4 font-medium text-right">Avg</th>
                <th className="pb-2 font-medium text-right">Change</th>
              </tr>
            </thead>
            <tbody>
              {data.hotspots.map((h) => (
                <tr key={`${h.file}:${h.function}`} className="border-t border-border/50">
                  <td className="py-2 pr-4">
                    <span className="text-text-primary">{h.function}</span>
                    <span className="text-text-muted ml-1.5">{truncateFile(h.file)}</span>
                  </td>
                  <td className="py-2 pr-4 text-right text-text-primary">{formatCost(h.cost)}</td>
                  <td className="py-2 pr-4 text-right text-text-secondary">{h.calls.toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right text-text-secondary">{formatCost(h.avgCost)}</td>
                  <td className="py-2 text-right"><ChangeIndicator change={h.costChange} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Context breakdown */}
      {contextKeys.length > 0 && (
        <div className="bg-surface-raised border border-border rounded-sm p-4">
          <div className="flex items-center gap-2 mb-4">
            <Tag size={14} className="text-text-muted" />
            <h3 className="text-xs font-mono font-semibold text-text-primary uppercase tracking-wider">Cost by Context</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {contextKeys.map((key) => {
              const values = data.context[key];
              const maxCtxCost = values[0]?.cost ?? 0;
              return (
                <div key={key}>
                  <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-2">{key}</div>
                  <div className="space-y-2">
                    {values.slice(0, 5).map((v) => (
                      <div key={v.value}>
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-xs font-mono text-text-secondary truncate max-w-[50%]">{v.value}</span>
                          <span className="text-xs font-mono text-text-primary">{formatCost(v.cost)}</span>
                        </div>
                        <CostBar cost={v.cost} maxCost={maxCtxCost} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Transform module trends into stacked chart data */
function buildChartData(data: InsightsData): Record<string, any>[] {
  const byDay = new Map<string, Record<string, any>>();
  for (const t of data.moduleTrends) {
    if (!byDay.has(t.day)) byDay.set(t.day, { day: t.day });
    byDay.get(t.day)![t.module] = t.cost;
  }
  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
}
