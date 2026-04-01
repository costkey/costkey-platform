import { useState } from "react";
import { Settings as SettingsIcon, Users, Key, Copy, Check, LogOut } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";

export default function Settings() {
  const { user, org, projects, members, logout } = useAuth();
  const [copied, setCopied] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"project" | "team" | "account">("project");

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const tabs = [
    { id: "project" as const, label: "Projects & API Keys", icon: <Key size={14} /> },
    { id: "team" as const, label: "Team", icon: <Users size={14} /> },
    { id: "account" as const, label: "Account", icon: <SettingsIcon size={14} /> },
  ];

  return (
    <div className="max-w-[900px] mx-auto px-6 py-8">
      <h1 className="text-xl font-semibold text-text-primary mb-6">Settings</h1>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-border mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-mono uppercase tracking-wider transition-colors cursor-pointer border-b-2 -mb-px ${
              activeTab === tab.id
                ? "text-accent border-accent"
                : "text-text-muted border-transparent hover:text-text-secondary"
            }`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Projects & API Keys */}
      {activeTab === "project" && (
        <div className="flex flex-col gap-4">
          {projects.map((project) => {
            const dsn = `https://${project.authKey}@costkey.dev/${project.id}`;
            return (
              <div key={project.id} className="bg-surface-raised border border-border rounded-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-text-primary">{project.name}</h3>
                  <span className="font-mono text-xs text-text-muted">{project.id}</span>
                </div>

                <div className="mb-3">
                  <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1.5">DSN</label>
                  <div className="flex items-center gap-2 bg-surface border border-border rounded-sm px-3 py-2">
                    <code className="font-mono text-xs text-accent flex-1 truncate">{dsn}</code>
                    <button onClick={() => copy(dsn, `dsn-${project.id}`)} className="text-text-muted hover:text-accent cursor-pointer">
                      {copied === `dsn-${project.id}` ? <Check size={14} className="text-green" /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1.5">API Key</label>
                  <div className="flex items-center gap-2 bg-surface border border-border rounded-sm px-3 py-2">
                    <code className="font-mono text-xs text-text-secondary flex-1">{project.authKey}</code>
                    <button onClick={() => copy(project.authKey, `key-${project.id}`)} className="text-text-muted hover:text-accent cursor-pointer">
                      {copied === `key-${project.id}` ? <Check size={14} className="text-green" /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Team */}
      {activeTab === "team" && (
        <div className="bg-surface-raised border border-border rounded-sm">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider">{org?.name} — Team Members</h3>
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
                <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm bg-surface-overlay text-text-secondary">
                  {member.role}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Account */}
      {activeTab === "account" && (
        <div className="flex flex-col gap-4">
          <div className="bg-surface-raised border border-border rounded-sm p-5">
            <h3 className="text-sm font-medium text-text-primary mb-4">Profile</h3>
            <div className="grid grid-cols-2 gap-4">
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

          <button
            onClick={logout}
            className="flex items-center gap-2 text-sm text-red hover:text-red/80 font-mono cursor-pointer w-fit"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
