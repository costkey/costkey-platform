import { useState, useEffect } from "react";
import { Settings as SettingsIcon, Users, Key, Bell, Copy, Check, RotateCw, LogOut, Plus, Trash2, Send, Shield, Server, Pencil, X } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { getCustomProviders, createCustomProvider, updateCustomProvider, deleteCustomProvider } from "../api";
import type { CustomProvider } from "../api";

export default function Settings() {
  const { user, org, projects, members, logout, refresh } = useAuth();
  const [copied, setCopied] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"project" | "team" | "providers" | "alerts" | "account">("project");

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const tabs = [
    { id: "project" as const, label: "Projects & Keys", icon: <Key size={14} /> },
    { id: "team" as const, label: "Team", icon: <Users size={14} /> },
    { id: "providers" as const, label: "Custom Providers", icon: <Server size={14} /> },
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
  const [invites, setInvites] = useState<Array<{ id: string; email: string; role: string; status: string; expires_at: string }>>([]);

  useEffect(() => {
    fetch("/api/v1/team/invites", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setInvites(d.invites ?? []))
      .catch(() => {});
  }, []);

  const sendInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    const res = await fetch("/api/v1/team/invite", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    if (res.ok) {
      setInviteEmail("");
      const data = await res.json();
      setInvites((prev) => [{ id: data.id, email: data.email, role: data.role, status: "pending", expires_at: data.expiresAt }, ...prev]);
    }
    setInviting(false);
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

      {/* Pending invites */}
      {invites.filter((i) => i.status === "pending").length > 0 && (
        <div className="bg-surface-raised border border-border rounded-sm">
          <div className="p-4 border-b border-border">
            <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider">Pending Invites</h3>
          </div>
          <div className="divide-y divide-border/50">
            {invites.filter((i) => i.status === "pending").map((invite) => (
              <div key={invite.id} className="flex items-center gap-4 px-4 py-3">
                <div className="w-8 h-8 rounded-full bg-surface-overlay flex items-center justify-center font-mono text-xs text-text-muted">?</div>
                <div className="flex-1">
                  <div className="font-mono text-sm text-text-secondary">{invite.email}</div>
                  <div className="font-mono text-xs text-text-muted">Expires {new Date(invite.expires_at).toLocaleDateString()}</div>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm bg-amber-muted text-amber">
                  pending
                </span>
              </div>
            ))}
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
