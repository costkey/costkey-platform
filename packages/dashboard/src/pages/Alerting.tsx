import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Mail, MessageSquare, Plus, Trash2, Webhook } from "lucide-react";
import { useAuth } from "../contexts/useAuth";
import {
  ALL_NOTIFICATION_EVENT_TYPES,
  createNotificationDestination,
  deleteNotificationDestination,
  getNotificationDeliveries,
  getNotificationDestinations,
  getNotificationPreferences,
  SettingsApiError,
  testNotificationDestination,
  updateNotificationPreferences,
  type NotificationDelivery,
  type NotificationDestination,
  type NotificationDestinationKind,
  type NotificationPreferences,
} from "../settingsApi";
import { EmptyPanel, LoadingRows, PageHeader, Panel, StatusPill } from "../components/ConsolePrimitives";
import { formatDateTime } from "../components/consoleFormatters";
import {
  channelLabel,
  deliveryStatusLabel,
  deliveryTone,
  destinationAddress,
  draftReady,
  eventLabel,
  HOURS,
  hourLabel,
  thresholdFromPercent,
  timezoneOptions,
  WEEKDAYS,
  withPreferenceDefaults,
  type DestinationDraft,
} from "./alertingModel";
import "./Settings.css";
import "./Alerting.css";

type Preferences = ReturnType<typeof withPreferenceDefaults>;
type PreferencePatch = Partial<NotificationPreferences>;

function errorText(error: unknown): string {
  if (error instanceof SettingsApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function canManageWorkspace(role: unknown): boolean {
  const value = String(role ?? "").toLowerCase();
  return value === "owner" || value === "admin";
}

const CHANNEL_ICONS: Record<string, ReactNode> = {
  email: <Mail size={14} />,
  slack: <MessageSquare size={14} />,
  webhook: <Webhook size={14} />,
};

function Switch({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return <button className={`settings-switch ${checked ? "on" : ""}`} type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} />;
}

function HourSelect({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (hour: number) => void }) {
  return <select id={id} aria-label={label} value={value} onChange={(event) => onChange(Number(event.target.value))}>{HOURS.map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}</select>;
}

function AlertCard({ title, checked, onToggle, disabled, children }: { title: string; checked: boolean; onToggle: (next: boolean) => void; disabled?: boolean; children?: ReactNode }) {
  return <div className={`alerting-card ${checked ? "on" : ""}`}>
    <div className="alerting-card-head"><h3>{title}</h3><Switch label={title} checked={checked} onChange={onToggle} disabled={disabled} /></div>
    {children && <div className="alerting-card-controls">{children}</div>}
  </div>;
}

export default function Alerting() {
  const { user, projects } = useAuth();
  const canManage = canManageWorkspace(user?.role);
  const userEmail = user?.email ?? "";
  const projectItems = projects as Array<{ id: string; name: string }>;
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const [scopeProjectId, setScopeProjectId] = useState("");
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [destinations, setDestinations] = useState<NotificationDestination[]>([]);
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<DestinationDraft>({ kind: "email", address: userEmail, secret: "", projectId: "" });
  const [adding, setAdding] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [thresholdDraft, setThresholdDraft] = useState<[string, string]>(["80", "100"]);

  const scope = scopeProjectId || undefined;
  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setError(null);
    try {
      const [preferenceResult, destinationResult, deliveryResult] = await Promise.all([
        getNotificationPreferences(scope),
        getNotificationDestinations(),
        getNotificationDeliveries(),
      ]);
      const next = withPreferenceDefaults(preferenceResult.preferences);
      setPreferences(next);
      setThresholdDraft([String(Math.round((next.policyWarningThresholds[0] ?? 0.8) * 100)), String(Math.round((next.policyWarningThresholds[1] ?? 1) * 100))]);
      setDestinations(Array.isArray(destinationResult.destinations) ? destinationResult.destinations : []);
      setDeliveries(Array.isArray(deliveryResult.deliveries) ? deliveryResult.deliveries : []);
    } catch (loadError) { setError(errorText(loadError)); }
    finally { setLoading(false); }
  }, [scope]);
  useEffect(() => { void load(); }, [load]);

  async function savePreference(patch: PreferencePatch): Promise<void> {
    if (!preferences) return;
    const previous = preferences;
    setPreferences({ ...preferences, ...patch } as Preferences);
    setError(null); setMessage(null);
    try {
      const result = await updateNotificationPreferences({ projectId: preferences.projectId ?? (scopeProjectId || null), ...patch });
      setPreferences(withPreferenceDefaults(result.preferences));
      setMessage("Saved.");
    } catch (saveError) {
      setPreferences(previous);
      setError(errorText(saveError));
    }
  }

  function saveThresholds(): void {
    if (!preferences) return;
    const first = thresholdFromPercent(thresholdDraft[0]);
    const second = thresholdFromPercent(thresholdDraft[1]);
    if (first == null || second == null) return;
    const next = [...new Set([first, second])].sort((a, b) => a - b);
    const current = preferences.policyWarningThresholds;
    if (next.length === current.length && next.every((value, index) => Math.abs(value - current[index]) < 1e-9)) return;
    void savePreference({ policyWarningThresholds: next });
  }

  function openForm(): void {
    setDraft({ kind: "email", address: userEmail, secret: "", projectId: "" });
    setFormOpen(true);
  }

  async function addDestination(): Promise<void> {
    if (!draftReady(draft)) return;
    setAdding(true); setError(null); setMessage(null);
    try {
      const result = await createNotificationDestination({
        kind: draft.kind,
        address: draft.address.trim(),
        secret: draft.kind === "webhook" ? draft.secret : undefined,
        eventTypes: ALL_NOTIFICATION_EVENT_TYPES,
        projectId: draft.projectId || null,
      });
      setDestinations((current) => [result.destination, ...current]);
      setFormOpen(false);
      setMessage("Destination added.");
    } catch (addError) { setError(errorText(addError)); }
    finally { setAdding(false); }
  }

  async function removeDestination(destination: NotificationDestination): Promise<void> {
    setError(null); setMessage(null);
    try {
      await deleteNotificationDestination(destination.id);
      setDestinations((current) => current.filter((item) => item.id !== destination.id));
      setMessage("Destination removed.");
    } catch (removeError) { setError(errorText(removeError)); }
    finally { setPendingRemoveId(null); }
  }

  async function testDestination(destination: NotificationDestination): Promise<void> {
    setTestingId(destination.id); setError(null); setMessage(null);
    try {
      const result = await testNotificationDestination(destination.id);
      if (result.delivery.status === "sent") setMessage("Test sent.");
      else setError(`Test ${result.delivery.status}: ${result.delivery.error ?? "not sent"}`);
    } catch (testError) {
      const delivery = testError instanceof SettingsApiError ? (testError.body as { delivery?: { status?: string; error?: string | null } } | null)?.delivery : undefined;
      setError(delivery ? `Test ${delivery.status === "suppressed" ? "not sent" : "failed"}: ${delivery.error ?? "no reason given"}` : errorText(testError));
    } finally {
      setTestingId(null);
      void load();
    }
  }

  const projectName = useCallback((projectId: string | null) => projectId ? projectItems.find((project) => project.id === projectId)?.name ?? projectId : "Workspace", [projectItems]);
  const destinationById = useMemo(() => new Map(destinations.map((destination) => [destination.id, destination])), [destinations]);
  const recentDeliveries = deliveries.slice(0, 20);
  const addressLabel = draft.kind === "email" ? "Email" : draft.kind === "slack" ? "Slack webhook URL" : "Webhook URL";

  return <div className="ck-main-inner settings-page alerting-page">
    <PageHeader title="Alerting" actions={<button className="ck-button ck-button-primary" type="button" onClick={openForm} disabled={formOpen}><Plus size={14} /> Add destination</button>} />
    {(message || error) && <div className={`settings-status-line ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>{error ?? message}</div>}

    <Panel title="Destinations">
      <div className="settings-card-body">
        {formOpen && <div className="settings-form alerting-form">
          <div className="settings-form-grid">
            <div className="settings-form-field">
              <label htmlFor="alerting-kind">Channel</label>
              <select id="alerting-kind" value={draft.kind} onChange={(event) => { const kind = event.target.value as NotificationDestinationKind; setDraft({ ...draft, kind, address: kind === "email" ? userEmail : "", secret: "" }); }}>
                <option value="email">Email</option>
                <option value="slack" disabled={!canManage}>Slack</option>
                <option value="webhook" disabled={!canManage}>Webhook</option>
              </select>
            </div>
            <div className="settings-form-field">
              <label htmlFor="alerting-scope-new">Scope</label>
              <select id="alerting-scope-new" value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}>
                <option value="">Workspace</option>
                {projectItems.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </div>
            <div className="settings-form-field full">
              <label htmlFor="alerting-address">{addressLabel}</label>
              <input id="alerting-address" type={draft.kind === "email" ? "email" : "url"} value={draft.address} autoComplete="off" spellCheck={false} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder={draft.kind === "email" ? "you@company.com" : draft.kind === "slack" ? "https://hooks.slack.com/services/…" : "https://"} />
            </div>
            {draft.kind === "webhook" && <div className="settings-form-field full">
              <label htmlFor="alerting-secret">Signing secret</label>
              <input id="alerting-secret" type="password" value={draft.secret} autoComplete="new-password" onChange={(event) => setDraft({ ...draft, secret: event.target.value })} placeholder="16+ characters" />
            </div>}
          </div>
          <div className="settings-form-footer">
            <button className="ck-button ck-button-quiet" type="button" onClick={() => setFormOpen(false)}>Cancel</button>
            <button className="ck-button ck-button-secondary" type="button" onClick={() => void addDestination()} disabled={adding || !draftReady(draft)}>{adding ? "Adding" : "Add"}</button>
          </div>
        </div>}
        {loading && destinations.length === 0 ? <LoadingRows count={2} columns={4} /> : destinations.length === 0 ? (!formOpen && <EmptyPanel title="No destinations" />) : <div className="settings-table-wrap">
          <table className="settings-table">
            <thead><tr><th>Channel</th><th>Address</th><th>Scope</th><th>Status</th><th>Last sent</th><th /></tr></thead>
            <tbody>{destinations.map((destination) => <tr key={destination.id}>
              <td className="primary"><span className="alerting-channel">{CHANNEL_ICONS[destination.kind]}{channelLabel(destination.kind)}</span></td>
              <td className="muted alerting-address">{destinationAddress(destination)}</td>
              <td className="muted">{projectName(destination.project_id)}</td>
              <td><StatusPill tone={destination.last_error ? "critical" : destination.enabled ? "good" : "neutral"}>{destination.last_error ? "Failing" : destination.enabled ? "Active" : "Paused"}</StatusPill></td>
              <td className="muted">{destination.last_delivery_at ? formatDateTime(destination.last_delivery_at) : "—"}</td>
              <td className="actions">{pendingRemoveId === destination.id
                ? <><button className="ck-button ck-button-quiet" type="button" onClick={() => setPendingRemoveId(null)}>Keep</button><button className="ck-button ck-button-danger-quiet ck-button-quiet" type="button" onClick={() => void removeDestination(destination)}>Remove</button></>
                : <><button className="ck-button ck-button-quiet" type="button" aria-label={`Send test to ${channelLabel(destination.kind)} ${destinationAddress(destination)}`} disabled={testingId === destination.id} onClick={() => void testDestination(destination)}>{testingId === destination.id ? "Sending" : "Test"}</button><button className="settings-icon-button" type="button" aria-label={`Remove ${channelLabel(destination.kind)} ${destinationAddress(destination)}`} onClick={() => setPendingRemoveId(destination.id)}><Trash2 size={13} /></button></>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>}
      </div>
    </Panel>

    <Panel title="What you hear about" actions={<div className="alerting-panel-controls">
      <div className="settings-project-picker"><label htmlFor="alerting-scope">Scope</label><select id="alerting-scope" value={scopeProjectId} onChange={(event) => setScopeProjectId(event.target.value)}><option value="">Workspace</option>{projectItems.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>
      {preferences && <div className="settings-project-picker"><label htmlFor="alerting-timezone">Timezone</label><select id="alerting-timezone" value={preferences.timezone || browserTimezone} onChange={(event) => void savePreference({ timezone: event.target.value })}>{timezoneOptions(preferences.timezone, browserTimezone).map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></div>}
    </div>}>
      <div className="settings-card-body">
        {loading && !preferences ? <LoadingRows count={2} columns={3} /> : !preferences ? <EmptyPanel title="Couldn’t load" action={<button className="ck-button ck-button-secondary" type="button" onClick={() => void load()}>Retry</button>} /> : <div className="alerting-grid">
          <AlertCard title="Weekly summary" checked={preferences.weeklySummaryEnabled} onToggle={(next) => void savePreference({ weeklySummaryEnabled: next })}>
            <select aria-label="Weekly summary day" value={preferences.weeklySummaryWeekday} onChange={(event) => void savePreference({ weeklySummaryWeekday: Number(event.target.value) })}>{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select>
            <HourSelect id="alerting-weekly-hour" label="Weekly summary time" value={preferences.weeklySummaryHour} onChange={(hour) => void savePreference({ weeklySummaryHour: hour })} />
          </AlertCard>
          <AlertCard title="Daily summary" checked={preferences.dailySummaryEnabled} onToggle={(next) => void savePreference({ dailySummaryEnabled: next })}>
            <HourSelect id="alerting-daily-hour" label="Daily summary time" value={preferences.dailySummaryHour} onChange={(hour) => void savePreference({ dailySummaryHour: hour })} />
          </AlertCard>
          <AlertCard title="Budget alerts" checked={preferences.budgetAlertsEnabled} onToggle={(next) => void savePreference({ budgetAlertsEnabled: next })}>
            <label className="alerting-inline-input"><input type="number" min="1" max="100" aria-label="First budget alert percent" value={thresholdDraft[0]} onChange={(event) => setThresholdDraft([event.target.value, thresholdDraft[1]])} onBlur={saveThresholds} />%</label>
            <label className="alerting-inline-input"><input type="number" min="1" max="100" aria-label="Second budget alert percent" value={thresholdDraft[1]} onChange={(event) => setThresholdDraft([thresholdDraft[0], event.target.value])} onBlur={saveThresholds} />%</label>
          </AlertCard>
          <AlertCard title="Refused calls" checked={preferences.enforcementEnabled} onToggle={(next) => void savePreference({ enforcementEnabled: next })} />
          <AlertCard title="Flagged changes" checked={preferences.findingsEnabled} onToggle={(next) => void savePreference({ findingsEnabled: next })} />
          <AlertCard title="Batch summaries" checked={preferences.executionReceiptsEnabled} onToggle={(next) => void savePreference({ executionReceiptsEnabled: next })} />
        </div>}
      </div>
    </Panel>

    <Panel title="Recent deliveries">
      {loading && deliveries.length === 0 ? <div className="settings-card-body"><LoadingRows count={3} columns={4} /></div> : recentDeliveries.length === 0 ? <EmptyPanel title="Nothing sent yet" /> : <div className="settings-table-wrap">
        <table className="settings-table">
          <thead><tr><th>When</th><th>Event</th><th>Destination</th><th>Status</th></tr></thead>
          <tbody>{recentDeliveries.map((delivery) => {
            const destination = delivery.destination_id ? destinationById.get(delivery.destination_id) : undefined;
            return <tr key={delivery.id}>
              <td className="muted">{formatDateTime(delivery.sent_at ?? delivery.created_at)}</td>
              <td className="primary">{eventLabel(delivery.event_type)}</td>
              <td className="muted">{destination ? `${channelLabel(destination.kind)} · ${destinationAddress(destination)}` : "—"}</td>
              <td><StatusPill tone={deliveryTone(delivery.status)}>{deliveryStatusLabel(delivery.status)}</StatusPill>{delivery.last_error && delivery.status !== "sent" && <div className="muted alerting-error" title={delivery.last_error}>{delivery.last_error}</div>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
    </Panel>
  </div>;
}
