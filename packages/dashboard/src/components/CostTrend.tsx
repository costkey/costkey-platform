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

interface Props {
  trends: TrendBucket[] | null;
  loading: boolean;
}

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
        ${payload[0].value.toFixed(2)}
      </p>
      <p className="font-mono text-xs text-text-muted">
        {payload[0].payload.calls.toLocaleString()} calls
      </p>
    </div>
  );
}

export default function CostTrend({ trends, loading }: Props) {
  if (loading || !trends) {
    return (
      <div className="bg-surface-raised border border-border rounded-sm p-5">
        <div className="h-4 w-28 bg-surface-overlay rounded-sm animate-pulse mb-4" />
        <div className="h-52 bg-surface-overlay rounded-sm animate-pulse" />
      </div>
    );
  }

  const data = trends.map((t) => ({
    ...t,
    label: formatDate(t.bucket),
  }));

  return (
    <div className="bg-surface-raised border border-border rounded-sm p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-semibold text-text-secondary tracking-wide uppercase">
          Daily Cost
        </h2>
        <span className="font-mono text-xs text-text-muted">
          {trends.length} days
        </span>
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
          <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(99, 102, 241, 0.06)" }} />
          <Bar
            dataKey="cost"
            fill="#6366f1"
            radius={[3, 3, 0, 0]}
            maxBarSize={40}
            opacity={0.85}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
