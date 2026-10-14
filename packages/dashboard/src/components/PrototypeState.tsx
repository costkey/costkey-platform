/* eslint-disable react-refresh/only-export-components -- state helpers intentionally share this component module. */
import { currentRouterPath } from "../basePath";
import type { ReactNode } from "react";
import { AlertTriangle, CircleAlert, Info, LockKeyhole, Search, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyPanel, LoadingRows, PageHeader, Panel, StatusPill } from "./ConsolePrimitives";

/**
 * The design prototype names states in the URL so a designer can inspect them
 * without mutating an account. Keep that contract in one place for the React
 * console too. Pages can still render their normal data below this surface;
 * this component only owns the explicit state treatment.
 */
/**
 * The named state contract is copied from `design/console-prototype/app.js`.
 * Keeping the values as a tuple gives the URL parser a real allow-list instead
 * of silently accepting a typo and rendering an arbitrary partial state.
 */
export const PROTOTYPE_STATE_VALUES = [
  "default", "loading", "error", "empty", "none", "new", "no-matches",
  "account-mismatch", "expired", "accepted", "removed", "offline",
  "received", "ungrouped", "missing-source", "unpriced", "restricted",
  "healthy", "finding", "partial", "no-policy", "no-baseline", "unassigned", "stale",
  "orphan", "uncaptured", "redacted", "long-content", "in-progress", "accounting", "interrupted", "child-error", "not-found", "no-access",
  "sparse", "baseline-unavailable", "acknowledged", "updated", "revised", "no-longer",
  "enforce", "per-execution", "review", "unavailable", "invalid", "proposal",
  "refused", "decision-unavailable", "stop-requested", "stop-confirmed", "unknown-exposure",
  "paused", "credits", "incomparable", "delayed", "voice", "job", "capabilities",
  "rejected", "delivery-failed", "credit-form", "cancelled",
] as const;

export type PrototypeState = typeof PROTOTYPE_STATE_VALUES[number];

const PROTOTYPE_STATE_SET: ReadonlySet<string> = new Set(PROTOTYPE_STATE_VALUES);

/** State names grouped by the prototype screen family for QA/catalog tooling. */
export const PROTOTYPE_STATE_MATRIX = {
  S00: ["default", "account-mismatch", "expired", "accepted", "removed", "offline", "loading", "error"],
  S01: ["default", "received", "ungrouped", "missing-source", "unpriced", "rejected", "restricted", "loading", "error"],
  S02: ["default", "healthy", "finding", "partial", "no-policy", "none", "new", "no-baseline", "unassigned", "loading", "error", "stale"],
  S03: ["default", "partial", "orphan", "no-matches", "loading", "error"],
  S04: ["default", "partial", "missing-source", "restricted", "expired", "uncaptured", "redacted", "long-content", "in-progress", "accounting", "interrupted", "child-error", "not-found", "no-access", "orphan"],
  S05: ["default", "partial", "empty", "loading", "error"],
  S06: ["default", "sparse", "partial", "loading", "error"],
  S07: ["default", "acknowledged", "updated", "revised", "no-longer", "baseline-unavailable", "loading", "error"],
  S08: ["default", "paused", "empty", "restricted", "loading", "error"],
  S09: ["default", "enforce", "per-execution", "review", "unavailable", "invalid", "proposal", "loading", "error"],
  S10: ["default", "refused", "decision-unavailable", "stop-requested", "stop-confirmed", "unknown-exposure", "paused", "restricted", "loading", "error"],
  S11: ["default", "credits", "partial", "sparse", "loading", "error"],
  S12: ["default", "incomparable", "partial", "loading", "error"],
  S13: ["default", "delayed", "voice", "job", "loading", "error"],
  S14: ["default", "capabilities", "rejected", "expired", "delivery-failed", "missing-source", "credit-form", "credits", "cancelled", "restricted", "loading", "error"],
} as const satisfies Record<string, readonly PrototypeState[]>;

export type PrototypeStateFamily = keyof typeof PROTOTYPE_STATE_MATRIX;

export function isPrototypeState(value: string | null | undefined): value is PrototypeState {
  return value != null && PROTOTYPE_STATE_SET.has(value);
}

export function prototypeState(params: URLSearchParams): PrototypeState {
  const value = params.get("state");
  // `expired-invite` was used by an earlier React-only preview; preserve it as
  // an alias while keeping the prototype's canonical name (`expired`).
  if (value === "expired-invite") return "expired";
  return isPrototypeState(value) ? value : "default";
}

export function prototypeRole(params: URLSearchParams, fallback: string): string {
  const value = params.get("role");
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  return ["owner", "admin", "developer", "viewer"].includes(normalized) ? normalized : fallback;
}

export function prototypeStateLabel(state: PrototypeState): string {
  return state.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type StatePanelProps = {
  state: PrototypeState;
  family: string;
  title?: string;
  backHref?: string;
  retryHref?: string;
  loadingRows?: number;
  children?: ReactNode;
};

function actionFor(state: PrototypeState, backHref: string, retryHref: string): ReactNode {
  if (["loading", "accounting", "in-progress"].includes(state)) return null;
  if (["no-access", "restricted"].includes(state)) return <Link className="ck-button ck-button-secondary" to={backHref}>Back to Overview</Link>;
  if (["not-found", "empty", "none", "new", "no-matches", "no-baseline", "baseline-unavailable", "sparse"].includes(state)) return <Link className="ck-button ck-button-primary" to={backHref}>{state === "new" ? "View setup" : state === "no-baseline" || state === "sparse" ? "View runs" : "Clear filters"}</Link>;
  if (["error", "child-error", "rejected", "delivery-failed"].includes(state)) return <Link className="ck-button ck-button-secondary" to={retryHref}>Retry</Link>;
  return null;
}

/** Full-page state treatment for named prototype variants. */
export function PrototypeStatePanel({ state, family, title, backHref = "/", retryHref, loadingRows = 5, children }: StatePanelProps): ReactNode {
  if (state === "default" || state === "healthy" || state === "finding" || state === "partial" || state === "stale" || state === "unassigned" || state === "acknowledged" || state === "updated" || state === "revised" || state === "no-longer" || state === "enforce" || state === "per-execution" || state === "review" || state === "unavailable" || state === "invalid" || state === "proposal" || state === "refused" || state === "decision-unavailable" || state === "stop-requested" || state === "stop-confirmed" || state === "unknown-exposure" || state === "paused" || state === "credits" || state === "incomparable" || state === "delayed" || state === "voice" || state === "job" || state === "capabilities" || state === "cancelled" || state === "credit-form" || state === "missing-source") return null;
  const effectiveRetry = retryHref ?? currentRouterPath();
  if (state === "loading") return <div className="ck-main-inner"><PageHeader eyebrow={family} title={title ?? `Loading ${family.toLowerCase()}`} /><Panel><LoadingRows count={loadingRows} columns={4} /></Panel></div>;
  if (state === "restricted") return <div className="ck-main-inner"><PageHeader eyebrow={family} title={title ?? "View only"} /><Panel><EmptyPanel title="View only" body="You can see costs and usage. Changing budgets or reading prompts needs a different role." action={actionFor(state, backHref, effectiveRetry)} icon={<LockKeyhole size={18} />} /></Panel></div>;
  if (state === "no-access") return <div className="ck-main-inner"><PageHeader eyebrow={family} title={title ?? "Access required"} /><Panel><EmptyPanel title={`You don’t have access to this ${family.toLowerCase()}`} body="This belongs to a project you can’t open." action={actionFor(state, backHref, effectiveRetry)} icon={<LockKeyhole size={18} />} /></Panel></div>;
  if (state === "not-found") return <div className="ck-main-inner"><PageHeader eyebrow={family} title={title ?? `${family} not found`} /><Panel><EmptyPanel title={`This ${family.toLowerCase()} isn’t available`} body="Check the link. Older details are removed after the retention period." action={actionFor(state, backHref, effectiveRetry)} icon={<Search size={18} />} /></Panel></div>;
  if (state === "error" || state === "child-error" || state === "rejected" || state === "delivery-failed") return <div className="ck-main-inner"><PageHeader eyebrow={family} title={title ?? "Could not refresh"} /><div className="ck-alert ck-alert-error" role="alert"><AlertTriangle size={15} /><div><strong>{state === "child-error" ? "Couldn’t load this call." : state === "rejected" ? "That wasn’t accepted." : "Couldn’t refresh this page."}</strong><p className="ck-alert-detail">Nothing was changed. Try again in a moment.</p></div></div><Panel><EmptyPanel title={state === "child-error" ? "The run itself is still here" : "Try again"} body="Try again, or go back." action={actionFor(state, backHref, effectiveRetry)} icon={<CircleAlert size={18} />} /></Panel></div>;
  if (["empty", "none", "new", "no-matches", "no-baseline", "baseline-unavailable", "sparse"].includes(state)) {
    const isNew = state === "new";
    const isSearch = state === "no-matches";
    const message = isNew ? "Connect your project and send a request from your app." : isSearch ? "Try a different search, or remove a filter." : state === "no-baseline" || state === "sparse" ? "There isn’t enough history to compare yet." : "Nothing here for this period.";
    return <div className="ck-main-inner"><PageHeader eyebrow={family} title={title ?? (isNew ? "Ready for your first run" : "No runs in this period")} /><Panel><EmptyPanel title={isSearch ? "No runs match" : isNew ? "Connect your app" : "Nothing to show yet"} body={message} action={actionFor(state, backHref, effectiveRetry)} icon={isSearch ? <Search size={18} /> : <ShieldCheck size={18} />} />{children}</Panel></div>;
  }
  return null;
}

/** Inline notices match the prototype's non-terminal states. */
export function PrototypeStateNotice({ state, family, role = "viewer", onRetry }: { state: PrototypeState; family: string; role?: string; onRetry?: () => void }): ReactNode {
  // Some pages intentionally render their own richer variant below this
  // notice. Keep the shared copy out of those pages so a named state never
  // produces two competing banners (Settings, Comparison, and Finding are
  // the current examples).
  const normalizedFamily = family.toLowerCase();
  if (normalizedFamily === "settings" && ["error", "restricted", "expired", "missing-source"].includes(state)) return null;
  if (normalizedFamily === "comparison" && state === "partial") return null;
  if (state === "partial") return <div className="ck-alert ck-partial-notice" role="status"><AlertTriangle size={15} /><div><strong>Some calls have no price yet.</strong> The known total is incomplete. <span className="muted">Totals include only priced calls.</span></div></div>;
  if (state === "stale") return <div className="ck-alert" role="status"><AlertTriangle size={15} /><div><strong>No recent runs.</strong> We haven’t heard from your app recently. {onRetry && <button className="ck-button ck-button-quiet" type="button" onClick={onRetry}>Refresh status</button>}</div></div>;
  if (state === "restricted") return <div className="ck-alert" role="status"><LockKeyhole size={15} /><div><strong>View only.</strong> {role === "developer" ? "You can see costs and suggest a budget. An Owner or Admin turns it on." : "Prompts, code locations and budget changes are hidden for your role."}</div></div>;
  if (state === "error") return <div className="ck-alert ck-alert-error" role="alert"><AlertTriangle size={15} /><div><strong>Couldn’t refresh {family.toLowerCase()}.</strong> Showing the last numbers we have. {onRetry && <button className="ck-button ck-button-quiet" type="button" onClick={onRetry}>Retry</button>}</div></div>;
  if (state === "healthy") return <div className="ck-alert" role="status"><StatusPill tone="good">Healthy</StatusPill><span>No unusual spending in this period.</span></div>;
  if (state === "no-baseline") return <div className="ck-alert" role="status"><Info size={15} /><div><strong>Not enough history yet.</strong> We need about a week of priced runs before we can forecast or flag changes.</div></div>;
  if (state === "unassigned") return <div className="ck-alert" role="status"><Info size={15} /><div><strong>Some runs have no feature label.</strong> They still count in every total. Add a label in the SDK to split them out.</div></div>;
  if (state === "no-policy") return <div className="ck-alert" role="status"><ShieldCheck size={15} /><div><strong>No budget yet.</strong> Set one to get alerts before you overspend.</div></div>;
  if ((normalizedFamily === "policy editor" || normalizedFamily === "budget editor") && state === "enforce") return <div className="ck-alert" role="status"><ShieldCheck size={15} /><div><strong>Stopping calls is selected.</strong> Check what it covers before saving.</div></div>;
  if ((normalizedFamily === "policy editor" || normalizedFamily === "budget editor") && state === "per-execution") return <div className="ck-alert" role="status"><ShieldCheck size={15} /><div><strong>A limit per batch.</strong> Each batch gets its own limit. They don’t share one pool.</div></div>;
  if ((normalizedFamily === "policy editor" || normalizedFamily === "budget editor") && state === "review") return <div className="ck-alert" role="status"><ShieldCheck size={15} /><div><strong>Check before saving.</strong> Confirm what it covers, the limit and what happens when it’s reached.</div></div>;
  if (state === "missing-source") return <div className="ck-alert" role="status"><AlertTriangle size={15} /><div><strong>No source map for this release.</strong> Costs are fine. Upload a source map to see file and function names.</div></div>;
  if (["expired", "uncaptured", "redacted", "long-content"].includes(state)) return <div className="ck-alert" role="status"><LockKeyhole size={15} /><div><strong>{state === "expired" ? "Prompts for this call have expired." : state === "uncaptured" ? "Prompts weren’t stored for this call." : state === "redacted" ? "Prompts were removed for privacy." : "Too long to show here."}</strong> Cost and usage metadata remain inspectable.</div></div>;
  if (state === "orphan") return <div className="ck-alert" role="status"><AlertTriangle size={15} /><div><strong>This call wasn’t part of a run.</strong> You can still inspect it on its own.</div></div>;
  if (["in-progress", "accounting", "interrupted"].includes(state)) return <div className="ck-alert" role="status"><StatusPill tone={state === "interrupted" ? "warn" : "info"}>{state === "in-progress" ? "In progress" : state === "accounting" ? "Accounting updating" : "Interrupted"}</StatusPill><span>Late costs may still arrive and update the total.</span></div>;
  return null;
}
