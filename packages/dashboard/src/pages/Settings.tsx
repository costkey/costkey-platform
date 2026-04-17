import { useState, useEffect } from "react";
import { Settings as SettingsIcon, Users, Key, Bell, Copy, Check, RotateCw, LogOut, Plus, Trash2, Send, Shield, Server, Pencil, X, DollarSign } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { getCustomProviders, createCustomProvider, updateCustomProvider, deleteCustomProvider } from "../api";
import type { CustomProvider } from "../api";

export default function Settings() {
  const { user, org, projects, members, logout, refresh } = useAuth();
  const [copied, setCopied] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"project" | "team" | "providers" | "budgets" | "alerts" | "account">("project");

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const tabs = [
    { id: "project" as const, label: "Projects & Keys", icon: <Key size={14} /> },
    { id: "team" as const, label: "Team", icon: <Users size={14} /> },
    { id: "providers" as const, label: "Custom Providers", icon: <Server size={14} /> },
    { id: "budgets" as const, label: "Budgets", icon: <DollarSign size={14} /> },
    { id: "alerts" as const, label: "Alerts", icon: <Bell size={14} /> },
    { id: "account" as const, label: "Account", icon: <SettingsIcon size={14} /> },
  ];

  return (
    <div className="max-w-[900px] mx-auto px-6 py-8">
      <h1 className="text-xl font-semibold text-text-primary mb-6">Settings</h1>

      <div className="flex gap-1 border-b border-border mb-8">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-mono uppercase tracking-wider transition-colors cursor-pointer border-b-2 -mb-px ${
              activeTab === tab.id ? "text-text-primary border-text-primary" : "text-text-muted border-transparent hover:text-text-secondary"
            }`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "project" && <ProjectsTab projects={projects} copied={copied} copy={copy} refresh={refresh} />}
      {activeTab === "team" && <TeamTab org={org} members={members} user={user} refresh={refresh} />}
      {activeTab === "providers" && <CustomProvidersTab projects={projects} />}
      {activeTab === "budgets" && <BudgetsTab projects={projects} userRole={user?.role ?? "member"} />}
      {activeTab === "alerts" && <AlertsTab />}
      {activeTab === "account" && <AccountTab user={user} org={org} logout={logout} />}
    </div>
  );
}

// ── Projects & API Keys Tab ──
function ProjectsTab({ projects, copied, copy, refresh }: {
  projects: Array<{ id: string; name: string; authKey: string; createdAt: string }>;
  copied: string | null; copy: (t: string, k: string) => void; refresh: () => Promise<void>;
}) {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null);

  const createProject = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    await fetch("/api/v1/projects", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    setNewName("");
    setCreating(false);
    await refresh();
  };

  const rotateKey = async (projectId: string) => {
    if (!confirm("Rotate API key? The old key will stop working immediately.")) return;
    setRotating(projectId);
    await fetch(`/api/v1/projects/${projectId}/rotate-key`, {
      method: "POST", credentials: "include",
    });
    setRotating(null);
    await refresh();
  };

  const deleteProject = async (projectId: string, name: string) => {
    if (!confirm(`Delete "${name}" and ALL its data? This cannot be undone.`)) return;
    await fetch(`/api/v1/projects/${projectId}`, { method: "DELETE", credentials: "include" });
    await refresh();
  };

  return (
    <div className="flex flex-col gap-5">
      {projects.map((project) => {
        const dsn = `https://${project.authKey}@app.costkey.dev/${project.id}`;
        return (
          <div key={project.id} className="bg-surface-raised border border-border rounded-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-text-primary">{project.name}</h3>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-text-muted">{project.id}</span>
                <button onClick={() => deleteProject(project.id, project.name)}
                  className="text-text-muted hover:text-red transition-colors cursor-pointer p-1" title="Delete project" aria-label="Delete project">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            <div className="mb-3">
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1.5">DSN</label>
              <div className="flex items-center gap-2 bg-surface border border-border rounded-sm px-3 py-2">
                <code className="font-mono text-xs text-accent flex-1 truncate">{dsn}</code>
                <button onClick={() => copy(dsn, `dsn-${project.id}`)} aria-label="Copy DSN" className="text-text-muted hover:text-accent cursor-pointer">
                  {copied === `dsn-${project.id}` ? <Check size={14} className="text-green" /> : <Copy size={14} />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1.5">API Key</label>
              <div className="flex items-center gap-2 bg-surface border border-border rounded-sm px-3 py-2">
                <code className="font-mono text-xs text-text-secondary flex-1">{project.authKey}</code>
                <button onClick={() => copy(project.authKey, `key-${project.id}`)} aria-label="Copy API key" className="text-text-muted hover:text-accent cursor-pointer">
                  {copied === `key-${project.id}` ? <Check size={14} className="text-green" /> : <Copy size={14} />}
                </button>
                <button onClick={() => rotateKey(project.id)}
                  className="text-text-muted hover:text-amber transition-colors cursor-pointer" title="Rotate key">
                  <RotateCw size={13} className={rotating === project.id ? "animate-spin" : ""} />
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {/* Create new project */}
      <div className="bg-surface-raised border border-border border-dashed rounded-sm p-5">
        <div className="flex items-center gap-3">
          <input
            type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="New project name..."
            className="flex-1 bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright"
            onKeyDown={(e) => e.key === "Enter" && createProject()}
          />
          <button onClick={createProject} disabled={creating || !newName.trim()}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-black font-mono text-xs px-4 py-2.5 rounded-sm transition-colors disabled:opacity-50 cursor-pointer">
            <Plus size={13} /> Create Project
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Team Tab ──
function TeamTab({ org, members, user, refresh }: {
  org: { id: string; name: string; slug: string } | null;
  members: Array<{ id: string; email: string; name: string; role: string }>;
  user: { id: string; role: string } | null;
  refresh: () => Promise<void>;
}) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invites, setInvites] = useState<Array<{
    id: string; email: string; role: string; status: string;
    expires_at: string; accepted_at: string | null; revoked_at: string | null;
    resent_count: number; invited_by_name: string;
  }>>([]);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);

  const loadInvites = async () => {
    const res = await fetch("/api/v1/team/invites", { credentials: "include" });
    if (res.ok) {
      const d = await res.json();
      setInvites(d.invites ?? []);
    }
  };

  useEffect(() => { void loadInvites(); }, []);

  const sendInvite = async () => {
    const trimmed = inviteEmail.trim();
    if (!trimmed) return;
    setInviting(true);
    setInviteError(null);
    const res = await fetch("/api/v1/team/invite", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: trimmed, role: inviteRole }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setInviteEmail("");
      await loadInvites();
    } else {
      setInviteError(data.error ?? "Failed to send invite");
    }
    setInviting(false);
  };

  const revokeInvite = async (id: string, email: string) => {
    if (!confirm(`Revoke the invite for ${email}?`)) return;
    setBusyInviteId(id);
    const res = await fetch(`/api/v1/team/invites/${id}`, {
      method: "DELETE", credentials: "include",
    });
    if (res.ok) await loadInvites();
    else {
      const data = await res.json().catch(() => ({}));
      alert(data.error ?? "Failed to revoke invite");
    }
    setBusyInviteId(null);
  };

  const resendInvite = async (id: string) => {
    setBusyInviteId(id);
    const res = await fetch(`/api/v1/team/invites/${id}/resend`, {
      method: "POST", credentials: "include",
    });
    if (res.ok) await loadInvites();
    else {
      const data = await res.json().catch(() => ({}));
      alert(data.error ?? "Failed to resend invite");
    }
    setBusyInviteId(null);
  };

  const removeMember = async (memberId: string, name: string) => {
    if (!confirm(`Remove ${name} from the organization?`)) return;
    await fetch(`/api/v1/team/members/${memberId}`, { method: "DELETE", credentials: "include" });
    await refresh();
  };

  const isOwner = user?.role === "owner";

  return (
    <div className="flex flex-col gap-5">
      {/* Invite form */}
      {isOwner && (
        <div className="bg-surface-raised border border-border rounded-sm p-5">
          <h3 className="text-sm font-medium text-text-primary mb-3">Invite team member</h3>
          <div className="flex items-center gap-3">
            <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="flex-1 bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright"
              onKeyDown={(e) => e.key === "Enter" && sendInvite()} />
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}
              className="bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-secondary font-mono cursor-pointer">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button onClick={sendInvite} disabled={inviting || !inviteEmail.trim()}
              className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-black font-mono text-xs px-4 py-2.5 rounded-sm transition-colors disabled:opacity-50 cursor-pointer">
              <Send size={13} /> Invite
            </button>
          </div>
          {inviteError && (
            <div className="mt-3 text-xs text-red font-mono">{inviteError}</div>
          )}
        </div>
      )}

      {/* Members */}
      <div className="bg-surface-raised border border-border rounded-sm">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider">{org?.name} — Members</h3>
          <span className="font-mono text-xs text-text-muted">{members.length} member{members.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="divide-y divide-border/50">
          {members.map((member) => (
            <div key={member.id} className="flex items-center gap-4 px-4 py-3">
              <div className="w-8 h-8 rounded-full bg-accent-muted flex items-center justify-center font-mono text-xs text-accent font-medium">
                {member.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-text-primary">{member.name}</div>
                <div className="font-mono text-xs text-text-muted">{member.email}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm ${
                  member.role === "owner" ? "bg-amber-muted text-amber" : "bg-surface-overlay text-text-secondary"
                }`}>
                  {member.role === "owner" && <Shield size={10} className="inline mr-1" />}
                  {member.role}
                </span>
                {isOwner && member.id !== user?.id && (
                  <button onClick={() => removeMember(member.id, member.name)}
                    aria-label="Remove member"
                    className="text-text-muted hover:text-red transition-colors cursor-pointer p-1">
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Invites (pending, expired, revoked — accepted ones become members) */}
      {invites.filter((i) => i.status !== "accepted").length > 0 && (
        <div className="bg-surface-raised border border-border rounded-sm">
          <div className="p-4 border-b border-border">
            <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider">Invites</h3>
          </div>
          <div className="divide-y divide-border/50">
            {invites.filter((i) => i.status !== "accepted").map((invite) => {
              const isPending = invite.status === "pending";
              const isExpired = invite.status === "expired";
              const isRevoked = invite.status === "revoked";
              const statusColors = isPending
                ? "bg-amber-muted text-amber"
                : isExpired
                ? "bg-surface-overlay text-text-muted"
                : "bg-red/10 text-red";
              const subtitle = isPending
                ? `Expires ${new Date(invite.expires_at).toLocaleDateString()}${invite.resent_count ? ` · resent ${invite.resent_count}×` : ""}`
                : isExpired
                ? `Expired ${new Date(invite.expires_at).toLocaleDateString()}`
                : isRevoked && invite.revoked_at
                ? `Revoked ${new Date(invite.revoked_at).toLocaleDateString()}`
                : invite.status;
              return (
                <div key={invite.id} className="flex items-center gap-4 px-4 py-3">
                  <div className="w-8 h-8 rounded-full bg-surface-overlay flex items-center justify-center font-mono text-xs text-text-muted">?</div>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm text-text-secondary truncate">{invite.email}</div>
                    <div className="font-mono text-xs text-text-muted">{subtitle}</div>
                  </div>
                  <span className={`font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm ${statusColors}`}>
                    {invite.status}
                  </span>
                  {isOwner && (isPending || isExpired) && (
                    <button
                      onClick={() => resendInvite(invite.id)}
                      disabled={busyInviteId === invite.id}
                      className="font-mono text-xs text-text-secondary hover:text-text-primary px-2 py-1 border border-border rounded-sm cursor-pointer disabled:opacity-50"
                      title={isExpired ? "Send a fresh invite" : "Re-send invite email with a new token"}
                    >
                      Resend
                    </button>
                  )}
                  {isOwner && isPending && (
                    <button
                      onClick={() => revokeInvite(invite.id, invite.email)}
                      disabled={busyInviteId === invite.id}
                      aria-label="Revoke invite"
                      className="text-text-muted hover:text-red transition-colors cursor-pointer p-1 disabled:opacity-50"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Budgets Tab ──
interface BudgetConfig {
  project_id: string;
  daily_usd: number | null;
  monthly_usd: number | null;
  calls_per_minute: number | null;
  tokens_per_minute: number | null;
  on_exceed: "throw" | "warn" | "block";
  alert_email: string | null;
  alert_webhook_url: string | null;
  alert_thresholds: number[];
  enabled: boolean;
}
interface BudgetStatus {
  daily: { spent: number; limit: number | null; pct: number | null };
  monthly: { spent: number; limit: number | null; pct: number | null };
  callsPerMinute: { observed: number; limit: number | null };
  tokensPerMinute: { observed: number; limit: number | null };
}

function SpendBar({ label, spent, limit, pct }: { label: string; spent: number; limit: number | null; pct: number | null }) {
  if (limit == null) {
    return (
      <div className="flex items-center justify-between px-4 py-3 border border-border rounded-sm bg-surface">
        <span className="text-xs font-mono uppercase tracking-wider text-text-muted">{label}</span>
        <span className="text-sm font-mono text-text-muted">${spent.toFixed(2)} (no limit)</span>
      </div>
    );
  }
  const p = Math.min(1, pct ?? spent / limit);
  const over = p >= 1;
  const warn = p >= 0.8 && !over;
  const color = over ? "bg-red" : warn ? "bg-amber" : "bg-accent";
  return (
    <div className="px-4 py-3 border border-border rounded-sm bg-surface">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono uppercase tracking-wider text-text-muted">{label}</span>
        <span className={`text-sm font-mono ${over ? "text-red" : warn ? "text-amber" : "text-text-primary"}`}>
          ${spent.toFixed(2)} / ${limit.toFixed(2)} ({Math.round(p * 100)}%)
        </span>
      </div>
      <div className="h-1.5 bg-surface-overlay rounded-sm overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${Math.min(100, p * 100)}%` }} />
      </div>
    </div>
  );
}

function BudgetsTab({ projects, userRole }: {
  projects: Array<{ id: string; name: string; authKey: string; createdAt: string }>;
  userRole: string;
}) {
  const canEdit = userRole === "owner" || userRole === "admin";
  const [selectedId, setSelectedId] = useState<string>(projects[0]?.id ?? "");
  const [config, setConfig] = useState<BudgetConfig | null>(null);
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [firings, setFirings] = useState<Array<{
    id: string; scope: string; threshold: number; window_key: string; fired_at: string; spent_usd: number; limit_usd: number;
  }>>([]);

  // Form state
  const [dailyUsd, setDailyUsd] = useState("");
  const [monthlyUsd, setMonthlyUsd] = useState("");
  const [callsPerMinute, setCallsPerMinute] = useState("");
  const [tokensPerMinute, setTokensPerMinute] = useState("");
  const [onExceed, setOnExceed] = useState<"throw" | "warn" | "block">("warn");
  const [alertEmail, setAlertEmail] = useState("");
  const [alertWebhook, setAlertWebhook] = useState("");
  const [enabled, setEnabled] = useState(true);

  const load = async (projectId: string) => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [budgetRes, firingsRes] = await Promise.all([
        fetch(`/api/v1/projects/${projectId}/budget`, { credentials: "include" }),
        fetch(`/api/v1/projects/${projectId}/budget/firings`, { credentials: "include" }),
      ]);
      if (budgetRes.ok) {
        const d = await budgetRes.json() as { config: BudgetConfig | null; status: BudgetStatus };
        setConfig(d.config);
        setStatus(d.status);
        setDailyUsd(d.config?.daily_usd != null ? String(d.config.daily_usd) : "");
        setMonthlyUsd(d.config?.monthly_usd != null ? String(d.config.monthly_usd) : "");
        setCallsPerMinute(d.config?.calls_per_minute != null ? String(d.config.calls_per_minute) : "");
        setTokensPerMinute(d.config?.tokens_per_minute != null ? String(d.config.tokens_per_minute) : "");
        setOnExceed(d.config?.on_exceed ?? "warn");
        setAlertEmail(d.config?.alert_email ?? "");
        setAlertWebhook(d.config?.alert_webhook_url ?? "");
        setEnabled(d.config?.enabled ?? true);
      }
      if (firingsRes.ok) {
        const f = await firingsRes.json() as { firings: typeof firings };
        setFirings(f.firings);
      }
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(selectedId); }, [selectedId]);

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`/api/v1/projects/${selectedId}/budget`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dailyUsd: dailyUsd === "" ? null : Number(dailyUsd),
          monthlyUsd: monthlyUsd === "" ? null : Number(monthlyUsd),
          callsPerMinute: callsPerMinute === "" ? null : Number(callsPerMinute),
          tokensPerMinute: tokensPerMinute === "" ? null : Number(tokensPerMinute),
          onExceed,
          alertEmail: alertEmail || null,
          alertWebhookUrl: alertWebhook || null,
          enabled,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSaveMsg("Saved");
        await load(selectedId);
        setTimeout(() => setSaveMsg(null), 2000);
      } else {
        setSaveMsg(data.error ?? "Failed to save");
      }
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!confirm("Remove budget configuration? Alerts will stop firing.")) return;
    const res = await fetch(`/api/v1/projects/${selectedId}/budget`, { method: "DELETE", credentials: "include" });
    if (res.ok) await load(selectedId);
  };

  if (projects.length === 0) {
    return <div className="text-sm text-text-muted">Create a project first to configure budgets.</div>;
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Project picker */}
      <div className="flex items-center gap-3">
        <label className="text-xs font-mono uppercase tracking-wider text-text-muted">Project</label>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono cursor-pointer"
        >
          {projects.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
        </select>
        {loading && <span className="text-xs text-text-muted font-mono">loading...</span>}
      </div>

      {/* Live spend bars */}
      {status && (
        <div className="flex flex-col gap-2">
          <SpendBar label="Daily spend" spent={status.daily.spent} limit={status.daily.limit} pct={status.daily.pct} />
          <SpendBar label="Monthly spend" spent={status.monthly.spent} limit={status.monthly.limit} pct={status.monthly.pct} />
          {(status.callsPerMinute.limit || status.tokensPerMinute.limit) && (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center justify-between px-4 py-3 border border-border rounded-sm bg-surface">
                <span className="text-xs font-mono uppercase tracking-wider text-text-muted">Calls / min</span>
                <span className="text-sm font-mono text-text-secondary">{status.callsPerMinute.observed} / {status.callsPerMinute.limit ?? "∞"}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-3 border border-border rounded-sm bg-surface">
                <span className="text-xs font-mono uppercase tracking-wider text-text-muted">Tokens / min</span>
                <span className="text-sm font-mono text-text-secondary">{status.tokensPerMinute.observed.toLocaleString()} / {status.tokensPerMinute.limit?.toLocaleString() ?? "∞"}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Config form */}
      <div className="bg-surface-raised border border-border rounded-sm p-5">
        <h3 className="text-sm font-medium text-text-primary mb-4">Budget & Rate Limits</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-text-muted mb-1.5">Daily cap (USD)</label>
            <input type="number" min="0" step="0.01" value={dailyUsd} onChange={(e) => setDailyUsd(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. 50"
              className="w-full bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright disabled:opacity-50" />
          </div>
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-text-muted mb-1.5">Monthly cap (USD)</label>
            <input type="number" min="0" step="0.01" value={monthlyUsd} onChange={(e) => setMonthlyUsd(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. 1000"
              className="w-full bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright disabled:opacity-50" />
          </div>
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-text-muted mb-1.5">Calls / minute</label>
            <input type="number" min="0" step="1" value={callsPerMinute} onChange={(e) => setCallsPerMinute(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. 60"
              className="w-full bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright disabled:opacity-50" />
          </div>
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-text-muted mb-1.5">Tokens / minute</label>
            <input type="number" min="0" step="1" value={tokensPerMinute} onChange={(e) => setTokensPerMinute(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. 100000"
              className="w-full bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright disabled:opacity-50" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-mono uppercase tracking-wider text-text-muted mb-1.5">When exceeded (applied by SDK)</label>
            <div className="flex gap-2">
              {(["warn", "throw", "block"] as const).map((p) => (
                <button key={p} disabled={!canEdit}
                  onClick={() => setOnExceed(p)}
                  className={`flex-1 px-3 py-2 text-xs font-mono uppercase tracking-wider border rounded-sm transition-colors disabled:opacity-50 cursor-pointer ${onExceed === p ? "border-accent bg-accent-muted text-accent" : "border-border bg-surface text-text-secondary hover:border-border-bright"}`}>
                  {p}
                </button>
              ))}
            </div>
            <p className="text-[11px] font-mono text-text-muted mt-2">
              <span className="text-text-secondary">warn</span>: log & proceed &middot;{" "}
              <span className="text-text-secondary">throw</span>: raise <code>CostKeyBudgetExceeded</code> &middot;{" "}
              <span className="text-text-secondary">block</span>: return synthetic 429 (graceful)
            </p>
          </div>
        </div>
      </div>

      {/* Alert channels */}
      <div className="bg-surface-raised border border-border rounded-sm p-5">
        <h3 className="text-sm font-medium text-text-primary mb-1">Alert channels</h3>
        <p className="text-xs text-text-muted mb-4 font-mono">Fires at 50%, 80%, 100% of each cap. Deduped per window.</p>
        <div className="flex flex-col gap-3">
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-text-muted mb-1.5">Webhook URL (Slack-compatible)</label>
            <input type="url" value={alertWebhook} onChange={(e) => setAlertWebhook(e.target.value)}
              disabled={!canEdit}
              placeholder="https://hooks.slack.com/services/..."
              className="w-full bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright disabled:opacity-50" />
          </div>
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-text-muted mb-1.5">Email</label>
            <input type="email" value={alertEmail} onChange={(e) => setAlertEmail(e.target.value)}
              disabled={!canEdit}
              placeholder="oncall@yourcompany.com"
              className="w-full bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright disabled:opacity-50" />
          </div>
          <label className="flex items-center gap-2 text-xs font-mono text-text-secondary cursor-pointer mt-1">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!canEdit} />
            Enabled
          </label>
        </div>
      </div>

      {canEdit && (
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={saving}
            className="bg-accent hover:bg-accent-hover text-black font-mono text-xs px-5 py-2.5 rounded-sm transition-colors disabled:opacity-50 cursor-pointer">
            {saving ? "Saving..." : "Save"}
          </button>
          {config && (
            <button onClick={remove}
              className="bg-surface-overlay hover:bg-surface-hover text-text-secondary font-mono text-xs px-4 py-2.5 rounded-sm border border-border transition-colors cursor-pointer">
              Remove budget
            </button>
          )}
          {saveMsg && <span className={`text-xs font-mono ${saveMsg === "Saved" ? "text-green" : "text-red"}`}>{saveMsg}</span>}
        </div>
      )}

      {/* Alert history */}
      {firings.length > 0 && (
        <div className="bg-surface-raised border border-border rounded-sm">
          <div className="p-4 border-b border-border">
            <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider">Recent alerts</h3>
          </div>
          <div className="divide-y divide-border/50">
            {firings.slice(0, 20).map((f) => {
              const pct = Math.round(f.threshold * 100);
              const over = pct >= 100;
              return (
                <div key={f.id} className="flex items-center gap-4 px-4 py-3">
                  <span className={`font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm ${over ? "bg-red/10 text-red" : pct >= 80 ? "bg-amber-muted text-amber" : "bg-surface-overlay text-text-muted"}`}>{f.scope} {pct}%</span>
                  <span className="flex-1 font-mono text-xs text-text-secondary">${Number(f.spent_usd).toFixed(2)} / ${Number(f.limit_usd).toFixed(2)}</span>
                  <span className="font-mono text-[10px] text-text-muted">{new Date(f.fired_at).toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Alerts Tab ──
function AlertsTab() {
  const [alerts, setAlerts] = useState<Array<{ id: string; type: string; threshold: number; channel: string; webhook_url: string; enabled: boolean; project_name: string | null }>>([]);
  const [newType, setNewType] = useState("daily_cost");
  const [newThreshold, setNewThreshold] = useState("");
  const [newWebhook, setNewWebhook] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch("/api/v1/alerts", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setAlerts(d.alerts ?? []))
      .catch(() => {});
  }, []);

  const createAlert = async () => {
    if (!newThreshold) return;
    setCreating(true);
    const res = await fetch("/api/v1/alerts", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: newType, threshold: parseFloat(newThreshold), channel: "webhook", webhookUrl: newWebhook || undefined }),
    });
    if (res.ok) {
      const data = await res.json();
      setAlerts((prev) => [{ ...data, enabled: true, project_name: null, webhook_url: newWebhook }, ...prev]);
      setNewThreshold("");
      setNewWebhook("");
    }
    setCreating(false);
  };

  const toggleAlert = async (alertId: string, enabled: boolean) => {
    await fetch(`/api/v1/alerts/${alertId}`, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    setAlerts((prev) => prev.map((a) => a.id === alertId ? { ...a, enabled } : a));
  };

  const deleteAlert = async (alertId: string) => {
    await fetch(`/api/v1/alerts/${alertId}`, { method: "DELETE", credentials: "include" });
    setAlerts((prev) => prev.filter((a) => a.id !== alertId));
  };

  const typeLabels: Record<string, string> = {
    daily_cost: "Daily cost exceeds",
    hourly_cost: "Hourly cost exceeds",
    cost_spike: "Cost spike detected",
    call_count: "Call count exceeds",
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Create alert */}
      <div className="bg-surface-raised border border-border rounded-sm p-5">
        <h3 className="text-sm font-medium text-text-primary mb-3">Create alert</h3>
        <div className="flex items-center gap-3 flex-wrap">
          <select value={newType} onChange={(e) => setNewType(e.target.value)}
            className="bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-secondary font-mono cursor-pointer">
            <option value="daily_cost">Daily cost exceeds</option>
            <option value="hourly_cost">Hourly cost exceeds</option>
            <option value="call_count">Call count exceeds</option>
          </select>
          <div className="flex items-center gap-1">
            <span className="text-text-muted font-mono text-sm">$</span>
            <input type="number" step="0.01" value={newThreshold} onChange={(e) => setNewThreshold(e.target.value)}
              placeholder="10.00"
              className="w-24 bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright" />
          </div>
          <input type="url" value={newWebhook} onChange={(e) => setNewWebhook(e.target.value)}
            placeholder="Slack webhook URL (optional)"
            className="flex-1 min-w-[200px] bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright" />
          <button onClick={createAlert} disabled={creating || !newThreshold}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-black font-mono text-xs px-4 py-2.5 rounded-sm transition-colors disabled:opacity-50 cursor-pointer">
            <Plus size={13} /> Create
          </button>
        </div>
      </div>

      {/* Alerts list */}
      {alerts.length > 0 ? (
        <div className="bg-surface-raised border border-border rounded-sm">
          <div className="p-4 border-b border-border">
            <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider">Active Alerts</h3>
          </div>
          <div className="divide-y divide-border/50">
            {alerts.map((alert) => (
              <div key={alert.id} className="flex items-center gap-4 px-4 py-3">
                <button onClick={() => toggleAlert(alert.id, !alert.enabled)}
                  className={`w-8 h-5 rounded-full relative cursor-pointer transition-colors ${alert.enabled ? "bg-green" : "bg-surface-overlay border border-border"}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${alert.enabled ? "left-3.5" : "left-0.5"}`} />
                </button>
                <div className="flex-1">
                  <div className="text-sm text-text-primary">
                    {typeLabels[alert.type] ?? alert.type} <span className="font-mono text-green">${alert.threshold}</span>
                  </div>
                  {alert.project_name && <div className="font-mono text-xs text-text-muted">{alert.project_name}</div>}
                  {alert.webhook_url && <div className="font-mono text-xs text-text-muted truncate max-w-[300px]">{alert.webhook_url}</div>}
                </div>
                <button onClick={() => deleteAlert(alert.id)} aria-label="Delete alert" className="text-text-muted hover:text-red transition-colors cursor-pointer p-1">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-surface-raised border border-border border-dashed rounded-sm p-8 text-center">
          <Bell size={24} className="text-text-muted mx-auto mb-2" />
          <p className="text-sm text-text-muted">No alerts configured yet</p>
          <p className="text-xs text-text-muted mt-1">Create an alert above to get notified when costs exceed a threshold</p>
        </div>
      )}
    </div>
  );
}

// ── Custom Providers Tab ──
function CustomProvidersTab({ projects }: {
  projects: Array<{ id: string; name: string }>;
}) {
  const [selectedProject, setSelectedProject] = useState(projects[0]?.id ?? "");
  const [providers, setProviders] = useState<CustomProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formHostname, setFormHostname] = useState("");
  const [formInputPath, setFormInputPath] = useState("usage.prompt_tokens");
  const [formOutputPath, setFormOutputPath] = useState("usage.completion_tokens");
  const [formModelPath, setFormModelPath] = useState("model");
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setFormName("");
    setFormHostname("");
    setFormInputPath("usage.prompt_tokens");
    setFormOutputPath("usage.completion_tokens");
    setFormModelPath("model");
    setEditingId(null);
  };

  const loadProviders = async (projectId: string) => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await getCustomProviders(projectId);
      setProviders(data.providers);
    } catch {
      setProviders([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (selectedProject) void loadProviders(selectedProject);
  }, [selectedProject]);

  const handleSave = async () => {
    if (!formName.trim() || !formHostname.trim()) return;
    setSaving(true);
    try {
      if (editingId) {
        await updateCustomProvider(selectedProject, editingId, {
          name: formName,
          hostname: formHostname,
          usageInputPath: formInputPath,
          usageOutputPath: formOutputPath,
          modelPath: formModelPath,
        });
      } else {
        await createCustomProvider(selectedProject, {
          name: formName,
          hostname: formHostname,
          usageInputPath: formInputPath,
          usageOutputPath: formOutputPath,
          modelPath: formModelPath,
        });
      }
      resetForm();
      await loadProviders(selectedProject);
    } catch {
      // ignore
    }
    setSaving(false);
  };

  const handleEdit = (p: CustomProvider) => {
    setEditingId(p.id);
    setFormName(p.name);
    setFormHostname(p.hostname);
    setFormInputPath(p.usage_input_path);
    setFormOutputPath(p.usage_output_path);
    setFormModelPath(p.model_path);
  };

  const handleDelete = async (providerId: string, name: string) => {
    if (!confirm(`Delete custom provider "${name}"?`)) return;
    await deleteCustomProvider(selectedProject, providerId);
    await loadProviders(selectedProject);
  };

  const handleToggle = async (providerId: string, enabled: boolean) => {
    await updateCustomProvider(selectedProject, providerId, { enabled });
    setProviders((prev) => prev.map((p) => p.id === providerId ? { ...p, enabled } : p));
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Project selector */}
      {projects.length > 1 && (
        <div className="flex items-center gap-3">
          <label className="text-xs font-mono text-text-muted uppercase tracking-wider">Project</label>
          <select
            value={selectedProject}
            onChange={(e) => { setSelectedProject(e.target.value); resetForm(); }}
            className="bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-secondary font-mono cursor-pointer"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Add / Edit form */}
      <div className="bg-surface-raised border border-border rounded-sm p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-text-primary">
            {editingId ? "Edit Provider" : "Add Custom Provider"}
          </h3>
          {editingId && (
            <button onClick={resetForm} aria-label="Cancel editing" className="text-text-muted hover:text-text-secondary cursor-pointer">
              <X size={14} />
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">Name</label>
            <input
              type="text" value={formName} onChange={(e) => setFormName(e.target.value)}
              placeholder="Internal LLM"
              className="w-full bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright"
            />
          </div>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">Hostname</label>
            <input
              type="text" value={formHostname} onChange={(e) => setFormHostname(e.target.value)}
              placeholder="ai.internal.company.com"
              className="w-full bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright"
            />
          </div>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">Input Tokens Path</label>
            <input
              type="text" value={formInputPath} onChange={(e) => setFormInputPath(e.target.value)}
              className="w-full bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright"
            />
          </div>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">Output Tokens Path</label>
            <input
              type="text" value={formOutputPath} onChange={(e) => setFormOutputPath(e.target.value)}
              className="w-full bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright"
            />
          </div>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">Model Path</label>
            <input
              type="text" value={formModelPath} onChange={(e) => setFormModelPath(e.target.value)}
              className="w-full bg-surface border border-border rounded-sm px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-border-bright"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={handleSave}
              disabled={saving || !formName.trim() || !formHostname.trim()}
              className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-black font-mono text-xs px-4 py-2.5 rounded-sm transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Plus size={13} /> {editingId ? "Update" : "Add Provider"}
            </button>
          </div>
        </div>
      </div>

      {/* Providers list */}
      {loading ? (
        <div className="text-center text-text-muted text-sm py-8">Loading...</div>
      ) : providers.length > 0 ? (
        <div className="bg-surface-raised border border-border rounded-sm">
          <div className="p-4 border-b border-border">
            <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider">
              Configured Providers
            </h3>
          </div>
          <div className="divide-y divide-border/50">
            {providers.map((p) => (
              <div key={p.id} className="flex items-center gap-4 px-4 py-3">
                <button
                  onClick={() => handleToggle(p.id, !p.enabled)}
                  className={`w-8 h-5 rounded-full relative cursor-pointer transition-colors flex-shrink-0 ${
                    p.enabled ? "bg-green" : "bg-surface-overlay border border-border"
                  }`}
                >
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    p.enabled ? "left-3.5" : "left-0.5"
                  }`} />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary">{p.name}</div>
                  <div className="font-mono text-xs text-text-muted truncate">{p.hostname}</div>
                </div>
                <div className="hidden sm:block text-right">
                  <div className="font-mono text-[10px] text-text-muted">
                    in: {p.usage_input_path} / out: {p.usage_output_path}
                  </div>
                  <div className="font-mono text-[10px] text-text-muted">model: {p.model_path}</div>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => handleEdit(p)}
                    className="text-text-muted hover:text-accent transition-colors cursor-pointer p-1" title="Edit" aria-label="Edit provider">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => handleDelete(p.id, p.name)}
                    className="text-text-muted hover:text-red transition-colors cursor-pointer p-1" title="Delete" aria-label="Delete provider">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-surface-raised border border-border border-dashed rounded-sm p-8 text-center">
          <Server size={24} className="text-text-muted mx-auto mb-2" />
          <p className="text-sm text-text-muted">No custom providers configured</p>
          <p className="text-xs text-text-muted mt-1">Add a provider above to track usage from custom or self-hosted AI endpoints</p>
        </div>
      )}
    </div>
  );
}

// ── Account Tab ──
function AccountTab({ user, org, logout }: {
  user: { id: string; email: string; name: string; role: string } | null;
  org: { id: string; name: string; slug: string } | null;
  logout: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="bg-surface-raised border border-border rounded-sm p-5">
        <h3 className="text-sm font-medium text-text-primary mb-4">Profile</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">Name</label>
            <div className="text-sm text-text-primary">{user?.name}</div>
          </div>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">Email</label>
            <div className="text-sm text-text-primary font-mono">{user?.email}</div>
          </div>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">Organization</label>
            <div className="text-sm text-text-primary">{org?.name}</div>
          </div>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">Role</label>
            <div className="text-sm text-text-primary capitalize">{user?.role}</div>
          </div>
        </div>
      </div>

      <button onClick={logout}
        className="flex items-center gap-2 text-sm text-red hover:text-red/80 font-mono cursor-pointer w-fit">
        <LogOut size={14} /> Sign out
      </button>
    </div>
  );
}
