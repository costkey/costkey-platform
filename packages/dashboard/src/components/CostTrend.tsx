import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { TrendBucket } from "../hooks/useApi";
import { truncateModel } from "../utils";
import { Layers } from "lucide-react";

type TimeRange = "mtd" | "7d" | "30d" | "3m" | "6m" | "1y";

interface Props {
  trends: TrendBucket[] | null;
  byModel?: Record<string, Array<{ bucket: string; cost: number }>>;
  loading: boolean;
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  groupByModel: boolean;
  onGroupByModelChange: (v: boolean) => void;
}

const RANGES: { id: TimeRange; label: string }[] = [
  { id: "7d", label: "7D" },
  { id: "mtd", label: "MTD" },
  { id: "30d", label: "30D" },
  { id: "3m", label: "3M" },
  { id: "6m", label: "6M" },
  { id: "1y", label: "1Y" },
];

const MODEL_COLORS = [
  "#34d399", "#22d3ee", "#fbbf24", "#a78bfa", "#fb7185",
  "#60a5fa", "#f97316", "#14b8a6", "#e879f9", "#84cc16",
];

function formatDate(bucket: string) {
  const d = new Date(bucket);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function StackedTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <div className="bg-surface-overlay border border-border-bright rounded-sm px-3 py-2 shadow-lg min-w-[140px]">
      <p className="text-text-muted text-xs mb-1.5">{label ? formatDate(label) : ""}</p>
      {payload.filter(p => p.value > 0).map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-3 mb-0.5">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
            <span className="font-mono text-[11px] text-text-secondary">{truncateModel(p.name)}</span>
          </div>
          <span className="font-mono text-[11px] text-text-primary">${p.value.toFixed(4)}</span>
        </div>
      ))}
      <div className="border-t border-border mt-1.5 pt-1.5 flex justify-between">
        <span className="font-mono text-[11px] text-text-muted">Total</span>
        <span className="font-mono text-[11px] text-text-primary font-semibold">${total.toFixed(4)}</span>
      </div>
    </div>
  );
}

function SimpleTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; payload: { calls: number } }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface-overlay border border-border-bright rounded-sm px-3 py-2 shadow-lg">
      <p className="text-text-muted text-xs mb-1">{label ? formatDate(label) : ""}</p>
      <p className="font-mono text-base text-text-primary font-bold">${payload[0].value.toFixed(4)}</p>
      <p className="font-mono text-xs text-text-muted">{payload[0].payload.calls.toLocaleString()} calls</p>
    </div>
  );
}

export default function CostTrend({ trends, byModel, loading, timeRange, onTimeRangeChange, groupByModel, onGroupByModelChange }: Props) {
  if (loading || !trends) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm p-5">
        <div className="flex items-center justify-between mb-5">
          <div className="h-4 w-28 bg-surface-overlay rounded-sm animate-pulse" />
          <div className="h-6 w-36 bg-surface-overlay rounded-sm animate-pulse" />
        </div>
        <div className="h-52 bg-surface-overlay rounded-sm animate-pulse" />
      </div>
    );
  }

  const totalCost = trends.reduce((sum, t) => sum + t.cost, 0);
  const totalCalls = trends.reduce((sum, t) => sum + t.calls, 0);

  // Build stacked data if groupByModel is on
  const modelNames = byModel ? Object.keys(byModel).sort((a, b) => {
    const aCost = byModel[a].reduce((s, d) => s + d.cost, 0);
    const bCost = byModel[b].reduce((s, d) => s + d.cost, 0);
    return bCost - aCost;
  }) : [];

  const data = trends.map((t) => {
    const row: Record<string, unknown> = { ...t, label: formatDate(t.bucket) };
    if (groupByModel && byModel) {
      for (const model of modelNames) {
        const match = byModel[model]?.find((d) => formatDate(d.bucket) === row.label);
        row[model] = match?.cost ?? 0;
      }
    }
    return row;
  });

  return (
    <div className="bg-surface-raised border border-border rounded-sm p-5">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-semibold text-text-secondary tracking-wide uppercase">
            Daily Cost
          </h2>
          <span className="font-mono text-[10px] text-text-muted">
            {totalCalls.toLocaleString()} calls · ${totalCost.toFixed(4)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onGroupByModelChange(!groupByModel)}
            className={`flex items-center gap-1.5 px-2 py-1 text-[11px] font-mono rounded-sm cursor-pointer transition-colors border ${
              groupByModel
                ? "border-border-bright text-text-primary bg-surface-hover"
                : "border-transparent text-text-muted hover:text-text-secondary"
            }`}
            title="Group by model"
          >
            <Layers size={12} />
            By model
          </button>
          <div className="flex items-center gap-0.5 bg-surface border border-border rounded-sm p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => onTimeRangeChange(r.id)}
                className={`px-2.5 py-1 text-[11px] font-mono font-medium rounded-sm cursor-pointer transition-colors ${
                  timeRange === r.id
                    ? "bg-surface-hover text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 12, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#52525b", fontSize: 11 }}
            dy={6}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#52525b", fontSize: 11 }}
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            dx={-4}
          />
          {groupByModel && byModel ? (
            <>
              <Tooltip content={<StackedTooltip />} cursor={{ fill: "rgba(255, 255, 255, 0.02)" }} />
              {modelNames.map((model, i) => (
                <Bar
                  key={model}
                  dataKey={model}
                  stackId="models"
                  fill={MODEL_COLORS[i % MODEL_COLORS.length]}
                  radius={i === 0 ? [0, 0, 0, 0] : i === modelNames.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                  maxBarSize={40}
                  opacity={0.8}
                />
              ))}
            </>
          ) : (
            <>
              <Tooltip content={<SimpleTooltip />} cursor={{ fill: "rgba(255, 255, 255, 0.02)" }} />
              <Bar
                dataKey="cost"
                fill="#fafafa"
                radius={[3, 3, 0, 0]}
                maxBarSize={40}
                opacity={0.15}
              />
            </>
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
