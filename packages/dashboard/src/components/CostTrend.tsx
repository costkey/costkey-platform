import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { TrendBucket } from "../hooks/useApi";

type TimeRange = "mtd" | "7d" | "30d" | "3m" | "6m" | "1y";

interface Props {
  trends: TrendBucket[] | null;
  loading: boolean;
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
}

const RANGES: { id: TimeRange; label: string }[] = [
  { id: "7d", label: "7D" },
  { id: "mtd", label: "MTD" },
  { id: "30d", label: "30D" },
  { id: "3m", label: "3M" },
  { id: "6m", label: "6M" },
  { id: "1y", label: "1Y" },
];

function formatDate(bucket: string) {
  const d = new Date(bucket);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; payload: { calls: number } }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface-overlay border border-border-bright rounded-sm px-3 py-2 shadow-lg">
      <p className="text-text-muted text-xs mb-1">{label ? formatDate(label) : ""}</p>
      <p className="font-mono text-base text-text-primary font-bold">
        ${payload[0].value.toFixed(4)}
      </p>
      <p className="font-mono text-xs text-text-muted">
        {payload[0].payload.calls.toLocaleString()} calls
      </p>
    </div>
  );
}

export default function CostTrend({ trends, loading, timeRange, onTimeRangeChange }: Props) {
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

  const data = trends.map((t) => ({
    ...t,
    label: formatDate(t.bucket),
  }));

  const totalCost = trends.reduce((sum, t) => sum + t.cost, 0);
  const totalCalls = trends.reduce((sum, t) => sum + t.calls, 0);

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

      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 12, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#484860", fontSize: 11 }}
            dy={6}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#484860", fontSize: 11 }}
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            dx={-4}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255, 255, 255, 0.02)" }} />
          <Bar
            dataKey="cost"
            fill="#fafafa"
            radius={[3, 3, 0, 0]}
            maxBarSize={40}
            opacity={0.15}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
