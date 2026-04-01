import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { TrendBucket } from "../hooks/useApi";

interface Props {
  trends: TrendBucket[] | null;
  loading: boolean;
}

function formatDate(bucket: string) {
  const d = new Date(bucket);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface-overlay border border-border-bright rounded-sm px-3 py-2 shadow-lg">
      <p className="text-text-secondary text-xs mb-1">{label ? formatDate(label) : ""}</p>
      <p className="font-mono text-sm text-text-primary font-semibold">
        ${payload[0].value.toFixed(4)}
      </p>
    </div>
  );
}

export default function CostTrend({ trends, loading }: Props) {
  if (loading || !trends) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm p-5 animate-in" style={{ animationDelay: "240ms" }}>
        <div className="h-4 w-32 bg-surface-overlay rounded-sm animate-pulse mb-4" />
        <div className="h-48 bg-surface-overlay rounded-sm animate-pulse" />
      </div>
    );
  }

  const data = trends.map((t) => ({
    ...t,
    label: formatDate(t.bucket),
  }));

  return (
    <div className="bg-surface-raised border border-border rounded-sm p-5 animate-in" style={{ animationDelay: "240ms" }}>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-sm font-medium text-text-secondary tracking-wide uppercase">
          Cost Over Time
        </h2>
        <span className="font-mono text-xs text-text-muted">
          {trends.length} days
        </span>
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#484860", fontSize: 11 }}
            dy={8}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#484860", fontSize: 11 }}
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            dx={-4}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="cost"
            stroke="#6366f1"
            strokeWidth={2}
            fill="url(#costGradient)"
            dot={false}
            activeDot={{
              r: 4,
              fill: "#6366f1",
              stroke: "#06060b",
              strokeWidth: 2,
            }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
