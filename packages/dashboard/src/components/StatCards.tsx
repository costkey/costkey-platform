import { DollarSign, Zap, Clock, Radio } from "lucide-react";
import type { Overview } from "../hooks/useApi";

interface Props {
  overview: Overview | null;
  loading: boolean;
}

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  delay: number;
}

function StatCard({ label, value, sub, icon, color, bgColor, delay }: StatCardProps) {
  return (
    <div
      className="animate-in bg-surface-raised border border-border rounded-sm p-5 flex flex-col gap-3 relative overflow-hidden"
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* Subtle top accent line */}
      <div className={`absolute top-0 left-0 right-0 h-px ${bgColor}`} style={{ opacity: 0.6 }} />

      <div className="flex items-center justify-between">
        <span className="text-text-secondary text-sm font-medium tracking-wide uppercase">
          {label}
        </span>
        <div className={`w-8 h-8 rounded-sm flex items-center justify-center ${bgColor}`}>
          <span className={color}>{icon}</span>
        </div>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="font-mono text-3xl font-semibold tracking-tight text-text-primary">
          {value}
        </span>
        {sub && (
          <span className="font-mono text-sm text-text-muted">{sub}</span>
        )}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="bg-surface-raised border border-border rounded-sm p-5 flex flex-col gap-3">
      <div className="h-4 w-24 bg-surface-overlay rounded-sm animate-pulse" />
      <div className="h-9 w-32 bg-surface-overlay rounded-sm animate-pulse" />
    </div>
  );
}

export default function StatCards({ overview, loading }: Props) {
  if (loading || !overview) {
    return (
      <div className="grid grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} />)}
      </div>
    );
  }

  const cost = overview.total_cost;
  const costStr = cost >= 1000
    ? `$${(cost / 1000).toFixed(1)}k`
    : cost >= 1
      ? `$${cost.toFixed(2)}`
      : `$${cost.toFixed(4)}`;

  return (
    <div className="grid grid-cols-4 gap-3">
      <StatCard
        label="Total Cost"
        value={costStr}
        sub="USD"
        icon={<DollarSign size={16} />}
        color="text-green"
        bgColor="bg-green-muted"
        delay={0}
      />
      <StatCard
        label="Total Calls"
        value={overview.total_calls.toLocaleString()}
        icon={<Zap size={16} />}
        color="text-accent"
        bgColor="bg-accent-muted"
        delay={60}
      />
      <StatCard
        label="Avg Latency"
        value={`${Math.round(overview.avg_duration_ms)}`}
        sub="ms"
        icon={<Clock size={16} />}
        color="text-amber"
        bgColor="bg-amber-muted"
        delay={120}
      />
      <StatCard
        label="Avg TTFT"
        value={overview.avg_ttft > 0 ? `${Math.round(overview.avg_ttft)}` : "—"}
        sub={overview.avg_ttft > 0 ? "ms" : ""}
        icon={<Radio size={16} />}
        color="text-cyan"
        bgColor="bg-cyan-muted"
        delay={180}
      />
    </div>
  );
}
