import { appUrl } from "../basePath";
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Minus, RefreshCw, X } from "lucide-react";
import type { Release } from "../api";
import { TimeRangePicker } from "./TimeRangePicker";
import type { ConsolePeriod } from "./consoleFormatters";
import { PrototypeIcon, type PrototypeIconName } from "./PrototypeIcon";

export type Tone = "good" | "warn" | "critical" | "info" | "neutral";

/** Spot illustrations from the design language (480 x 320 viewBox SVGs). */
export type IllustrationName = "first-light" | "a-little-ahead" | "room-to-explore" | "a-closer-look" | "observation-note";

/** Spot art for onboarding, summaries and empty states. Never placed over live data. */
export function Illustration({ name, width = 200, className = "" }: { name: IllustrationName; width?: number; className?: string }) {
  return <img className={`ck-illustration ${className}`} src={appUrl(`/assets/illustrations/${name}.svg`)} width={width} height={Math.round(width * 2 / 3)} alt="" aria-hidden="true" draggable={false} />;
}

const STATUS_ICON: Record<Tone, PrototypeIconName> = { good: "check", warn: "alert", critical: "pause", info: "info", neutral: "info" };

/** One-line scoped status ("All tracked projects are within budget."). Always an icon and words. */
export function StatusLine({ tone = "good", children, right, onDismiss }: { tone?: Tone; children: ReactNode; right?: ReactNode; /** Shows a close button at the right edge. */ onDismiss?: () => void }) {
  return (
    <div className={`ck-status-line ck-status-line-${tone} ${onDismiss ? "is-dismissible" : ""}`} role="status">
      <span className="ck-status-line-text"><PrototypeIcon name={STATUS_ICON[tone]} size={16} />{children}</span>
      {(right || onDismiss) && <span className="ck-status-line-right">{right}{onDismiss && <button className="ck-status-line-close" type="button" aria-label="Dismiss this message" onClick={onDismiss}><X size={14} aria-hidden="true" /></button>}</span>}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="ck-page-header">
      <div className="min-w-0">
        {eyebrow && <div className="ck-eyebrow">{eyebrow}</div>}
        <h1 className="ck-page-title">{title}</h1>
        {description && <p className="ck-page-description">{description}</p>}
      </div>
      {actions && <div className="ck-page-actions">{actions}</div>}
    </div>
  );
}

export type Period = ConsolePeriod;

/**
 * Period and environment as compact pills for the page header. There is no
 * filter bar: pages put this in their header actions.
 */
const DEFAULT_PERIODS: Period[] = ["24h", "7d", "30d", "mtd"];

export function ScopeToolbar({
  period,
  onPeriodChange,
  periods = DEFAULT_PERIODS,
  customRelative = false,
  deploy,
  timezone,
  environment = "all",
  onEnvironmentChange,
  environmentOptions,
  customFrom,
  customTo,
  customTime = false,
  onCustomRangeChange,
  chips,
  right,
}: {
  period: Period;
  onPeriodChange: (period: Period) => void;
  /** The time picker's quick picks, in order. */
  periods?: Period[];
  /** Offer "last N minutes/hours/days/weeks". */
  customRelative?: boolean;
  /** Offer "since the last deploy". */
  deploy?: { release: Release | null; loaded: boolean };
  environment?: string;
  onEnvironmentChange?: (environment: string) => void;
  environmentOptions?: Array<{ value: string; label: string }>;
  customFrom?: string;
  customTo?: string;
  /** Custom ranges pick a time of day as well as a day (datetime-local values). */
  customTime?: boolean;
  onCustomRangeChange?: (from: string, to: string) => void;
  currency?: string;
  currencyNote?: string;
  timezone?: string | null;
  chips?: ReactNode;
  right?: ReactNode;
}) {
  const environments = environmentOptions ?? [{ value: "all", label: "All environments" }];
  const showEnvironment = Boolean(onEnvironmentChange) && (environments.length > 1 || environment !== "all");
  return (
    <div className="ck-scope-pills">
      {chips}
      {showEnvironment && <span className="ck-pill-select"><select aria-label="Environment" value={environment} onChange={(event) => onEnvironmentChange?.(event.target.value)}>{environments.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><PrototypeIcon name="down" size={12} /></span>}
      <TimeRangePicker
        period={period}
        onPeriodChange={onPeriodChange}
        quick={periods}
        customRelative={customRelative}
        deploy={deploy}
        timezone={timezone}
        absolute={onCustomRangeChange ? { from: customFrom, to: customTo, withTime: customTime, onApply: onCustomRangeChange } : undefined}
      />
      {right}
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
  id,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`ck-panel ${className}`} id={id}>
      {(title || subtitle || actions) && (
        <header className="ck-panel-header">
          <div className="min-w-0">
            {title && <h2 className="ck-panel-title">{title}</h2>}
            {subtitle && <p className="ck-panel-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="ck-panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
  loading = false,
  icon,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  tone?: Tone;
  loading?: boolean;
  icon?: PrototypeIconName;
}) {
  return (
    <article className="ck-metric-card">
      <div className="ck-metric-label"><span>{label}</span>{icon && <PrototypeIcon name={icon} size={16} />}</div>
      {loading ? <div className="ck-skeleton ck-skeleton-metric" /> : <div className={`ck-metric-value ck-tone-${tone}`}>{value}</div>}
      {detail && <div className="ck-metric-detail">{detail}</div>}
    </article>
  );
}

/** Status pill: icon and words, never color alone. Pass `icon={false}` for a plain label. */
export function StatusPill({ tone = "neutral", children, icon }: { tone?: Tone; children: ReactNode; icon?: PrototypeIconName | false }) {
  const glyph = icon === false ? null : icon ?? (tone === "good" ? "check" : tone === "warn" ? "alert" : tone === "critical" ? "pause" : null);
  return <span className={`ck-status-pill ck-status-${tone}`}>{glyph && <PrototypeIcon name={glyph} size={13} />}{children}</span>;
}

/** Period-over-period change in words ("12.4% lower than last month"). */
export function Delta({ value, comparison = "the previous period" }: { value: number | null | undefined; comparison?: string }) {
  if (value == null || !Number.isFinite(Number(value))) {
    // Nothing earlier to compare with: say nothing rather than filler.
    return null;
  }
  const numeric = Number(value);
  if (Math.abs(numeric) < 0.05) {
    return <span className="ck-delta ck-delta-neutral"><Minus size={12} aria-hidden="true" /> Same as {comparison}</span>;
  }
  const rising = numeric > 0;
  return (
    <span className={`ck-delta ${rising ? "ck-delta-warn" : "ck-delta-good"}`}>
      {rising ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />}
      {Math.abs(numeric).toFixed(1)}% {rising ? "higher" : "lower"} than {comparison}
    </span>
  );
}

export function LoadingRows({ count = 5, columns = 4 }: { count?: number; columns?: number }) {
  return (
    <div className="ck-loading-rows" aria-label="Loading">
      {Array.from({ length: count }, (_, row) => (
        <div className="ck-loading-row" key={row}>
          {Array.from({ length: columns }, (_, column) => (
            <span className={`ck-skeleton ${column === 0 ? "ck-skeleton-wide" : ""}`} key={column} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyPanel({
  title,
  body,
  action,
  icon,
  illustration,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: ReactNode;
  illustration?: IllustrationName;
}) {
  return (
    <div className="ck-empty-panel">
      {illustration ? <Illustration name={illustration} width={220} className="ck-empty-art" /> : icon && <div className="ck-empty-icon">{icon}</div>}
      <h2 className="ck-empty-title">{title}</h2>
      {body && <p className="ck-empty-body">{body}</p>}
      {action && <div className="ck-empty-action">{action}</div>}
    </div>
  );
}

export function RefreshButton({ onClick, loading = false }: { onClick: () => void; loading?: boolean }) {
  return (
    <button className="ck-button ck-button-quiet ck-refresh-button" onClick={onClick} disabled={loading} type="button">
      <RefreshCw size={14} className={loading ? "ck-spin" : ""} aria-hidden="true" />
      {loading ? "Updating" : "Refresh"}
    </button>
  );
}

/** "Showing 51–100 of 452", rows per page, and previous and next. Nothing when one page holds everything. */
export function Pagination({ offset, limit, total, onOffsetChange, onLimitChange }: { offset: number; limit: number; total: number; onOffsetChange: (offset: number) => void; onLimitChange: (limit: number) => void }) {
  if (total <= 0) return null;
  if (total <= limit && offset === 0) return null;
  const first = Math.min(offset + 1, total);
  const last = Math.min(offset + limit, total);
  const canPrevious = offset > 0;
  const canNext = last < total;
  return <nav className="ck-pagination" aria-label="Pages"><span>Showing {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()}</span><div><label className="ck-pagination-size">Rows <select className="ck-select" value={limit} onChange={(event) => onLimitChange(Number(event.target.value))}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option><option value={200}>200</option></select></label><button className="ck-button ck-button-quiet" type="button" aria-label="Previous page" disabled={!canPrevious} onClick={() => onOffsetChange(Math.max(0, offset - limit))}><ChevronLeft size={13} /> Previous</button><span className="ck-pagination-page">Page {Math.floor(offset / limit) + 1} of {Math.max(1, Math.ceil(total / limit))}</span><button className="ck-button ck-button-quiet" type="button" aria-label="Next page" disabled={!canNext} onClick={() => onOffsetChange(offset + limit)}>Next <ChevronRight size={13} /></button></div></nav>;
}
