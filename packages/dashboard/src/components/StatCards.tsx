import { DollarSign, Zap, Clock, Radio } from "lucide-react";
import type { Overview } from "../hooks/useApi";

interface Props {
  overview: Overview | null;
  loading: boolean;
}

function formatCost(cost: number): string {
  if (cost >= 1000) return `$${(cost / 1000).toFixed(1)}k`;
  return `$${cost.toFixed(2)}`;
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
      className="animate-in bg-surface-raised border border-border rounded-sm px-4 py-3.5 flex flex-col gap-2 relative overflow-hidden"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className={`absolute top-0 left-0 right-0 h-px ${bgColor}`} style={{ opacity: 0.6 }} />
      <div className="flex items-center justify-between">
        <span className="text-text-muted text-[11px] font-medium tracking-wider uppercase">
          {label}
        </span>
        <div className={`w-6 h-6 rounded-sm flex items-center justify-center ${bgColor}`}>
          <span className={color}>{icon}</span>
        </div>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-semibold tracking-tight text-text-primary">
          {value}
        </span>
        {sub && (
          <span className="font-mono text-xs text-text-muted">{sub}</span>
        )}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="bg-surface-raised border border-border rounded-sm px-4 py-3.5 flex flex-col gap-2">
      <div className="h-3 w-20 bg-surface-overlay rounded-sm animate-pulse" />
      <div className="h-7 w-28 bg-surface-overlay rounded-sm animate-pulse" />
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

  return (
    <div className="grid grid-cols-4 gap-3">
      <StatCard
        label="Total Cost"
        value={formatCost(overview.total_cost)}
        sub="USD"
        icon={<DollarSign size={14} />}
        color="text-green"
        bgColor="bg-green-muted"
        delay={0}
      />
      <StatCard
        label="Total Calls"
        value={overview.total_calls.toLocaleString()}
        icon={<Zap size={14} />}
        color="text-accent"
        bgColor="bg-accent-muted"
        delay={40}
      />
      <StatCard
        label="Avg Latency"
        value={`${Math.round(overview.avg_duration_ms)}`}
        sub="ms"
        icon={<Clock size={14} />}
        color="text-amber"
        bgColor="bg-amber-muted"
        delay={80}
      />
      <StatCard
        label="Avg TTFT"
        value={overview.avg_ttft > 0 ? `${Math.round(overview.avg_ttft)}` : "—"}
        sub={overview.avg_ttft > 0 ? "ms" : ""}
        icon={<Radio size={14} />}
        color="text-cyan"
        bgColor="bg-cyan-muted"
        delay={120}
      />
    </div>
  );
}
