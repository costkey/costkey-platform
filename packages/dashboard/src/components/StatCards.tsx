import { DollarSign, Zap, Clock, Radio, Gauge } from "lucide-react";
import type { Overview } from "../hooks/useApi";
import { formatCost, formatDuration } from "../utils";

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
      className="animate-in stat-card-hover bg-surface-raised border border-border rounded-sm px-4 py-4 flex flex-col gap-2"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center justify-between">
        <span className="text-text-muted text-xs font-medium tracking-wide uppercase">
          {label}
        </span>
        <span className={`${color} opacity-50`}>{icon}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-bold tracking-tight text-text-primary">
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
    <div className="bg-surface-raised border border-border rounded-sm px-4 py-4 flex flex-col gap-2">
      <div className="h-4 w-20 bg-surface-overlay rounded-sm animate-pulse" />
      <div className="h-8 w-28 bg-surface-overlay rounded-sm animate-pulse" />
    </div>
  );
}

export default function StatCards({ overview, loading }: Props) {
  if (loading || !overview) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} />)}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      <StatCard
        label="Total Cost"
        value={formatCost(overview.total_cost)}
        icon={<DollarSign size={15} />}
        color="text-green"
        bgColor="bg-green-muted"
        delay={0}
      />
      <StatCard
        label="Total Calls"
        value={overview.total_calls.toLocaleString()}
        icon={<Zap size={15} />}
        color="text-cyan"
        bgColor="bg-cyan-muted"
        delay={40}
      />
      <StatCard
        label="Avg Latency"
        value={formatDuration(overview.avg_duration_ms)}
        icon={<Clock size={15} />}
        color="text-amber"
        bgColor="bg-amber-muted"
        delay={80}
      />
      <StatCard
        label="Avg TTFT"
        value={overview.avg_ttft > 0 ? formatDuration(overview.avg_ttft) : "—"}
        icon={<Radio size={15} />}
        color="text-cyan"
        bgColor="bg-cyan-muted"
        delay={120}
      />
      <StatCard
        label="Avg TPS"
        value={overview.avg_tps > 0 ? `${Math.round(overview.avg_tps)}` : "—"}
        sub={overview.avg_tps > 0 ? "tok/s" : ""}
        icon={<Gauge size={15} />}
        color="text-violet"
        bgColor="bg-violet-muted"
        delay={160}
      />
    </div>
  );
}
