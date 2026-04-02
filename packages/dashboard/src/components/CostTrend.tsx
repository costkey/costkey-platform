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
    <div className="bg-surface-overlay border border-border-bright rounded-sm px-2.5 py-1.5 shadow-lg">
      <p className="text-text-muted text-[10px] mb-0.5">{label ? formatDate(label) : ""}</p>
      <p className="font-mono text-sm text-text-primary font-semibold">
        ${payload[0].value.toFixed(2)}
      </p>
    </div>
  );
}

export default function CostTrend({ trends, loading }: Props) {
  if (loading || !trends) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm p-4">
        <div className="h-3 w-28 bg-surface-overlay rounded-sm animate-pulse mb-3" />
        <div className="h-44 bg-surface-overlay rounded-sm animate-pulse" />
      </div>
    );
  }

  const data = trends.map((t) => ({
    ...t,
    label: formatDate(t.bucket),
  }));

  return (
    <div className="bg-surface-raised border border-border rounded-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[11px] font-medium text-text-muted tracking-wider uppercase">
          Cost Over Time
        </h2>
        <span className="font-mono text-[10px] text-text-muted">
          {trends.length} days
        </span>
      </div>

      <ResponsiveContainer width="100%" height={190}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
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
            tick={{ fill: "#484860", fontSize: 10 }}
            dy={6}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#484860", fontSize: 10 }}
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
              r: 3,
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
