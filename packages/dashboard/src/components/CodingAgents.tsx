import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { LoadingRows, Panel } from "./ConsolePrimitives";
import { formatDateTime } from "./consoleFormatters";
import { AGENT_CLIENTS, agentSetups, expiryDate, type AgentClient } from "./agentSetup";
import { createAgentToken, getAgentTokens, revokeAgentToken, SettingsApiError, type AgentTokenList } from "../settingsApi";

interface ProjectOption { id: string; name: string }

function errorText(error: unknown): string {
  if (error instanceof SettingsApiError) return error.message;
  return error instanceof Error ? error.message : "Something went wrong. Nothing was changed.";
}

function CopyText({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return <button className="ck-button ck-button-quiet sm" type="button" onClick={() => void copy()} aria-label={copied ? `${label} copied` : label}>{copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copied ? "Copied" : "Copy"}</button>;
}

/** Settings, Coding agents: read-only tokens for Claude Code, Cursor, Codex and VS Code. */
export default function CodingAgents({ projects }: { projects: ProjectOption[] }) {
  const [list, setList] = useState<AgentTokenList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState("90");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; secret: string; mcpUrl: string } | null>(null);
  const [client, setClient] = useState<AgentClient>("claude");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await getAgentTokens());
      setError(null);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create(): Promise<void> {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createAgentToken({ name: name.trim(), projectIds: projectIds.length > 0 ? projectIds : null, expiresAt: expiryDate(expiry) });
      setCreated({ name: result.token.name, secret: result.secret, mcpUrl: result.mcpUrl });
      setName("");
      setProjectIds([]);
      await load();
    } catch (createError) {
      setError(errorText(createError));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(tokenId: string): Promise<void> {
    setError(null);
    try {
      await revokeAgentToken(tokenId);
      setConfirmingId(null);
      await load();
    } catch (revokeError) {
      setError(errorText(revokeError));
    }
  }

  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? id;
  const setup = created ? agentSetups(created.mcpUrl, created.secret).find((item) => item.id === client) : null;
  const tokens = list?.tokens ?? [];

  return <>
    <div className="settings-section-title"><div><h2>Coding agents</h2><p>Claude Code, Cursor, Codex and VS Code can read calls, runs and costs here with a token. Tokens are read only and see what you see.</p></div></div>
    {list && !list.mcpEnabled && <div className="ck-alert" role="status"><AlertTriangle size={15} /><div><strong>The MCP endpoint is off on this server.</strong> Set COSTKEY_MCP_ENABLED=true to turn it on.</div></div>}
    {error && <div className="ck-alert ck-alert-error" role="alert"><AlertTriangle size={15} /><span>{error}</span></div>}

    {created && setup && <Panel title={`Token for ${created.name}`} subtitle="Copy it now. You won't see it again.">
      <div className="settings-card-body">
        <div className="settings-key-row"><KeyRound size={14} aria-hidden="true" /><code className="revealed">{created.secret}</code><CopyText value={created.secret} label="Copy token" /></div>
        <div className="ck-segmented" role="tablist" aria-label="Coding agent" style={{ marginTop: 16 }}>
          {AGENT_CLIENTS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={client === item.id} className={client === item.id ? "active" : ""} onClick={() => setClient(item.id)}>{item.label}</button>)}
        </div>
        <div className="setup-section-heading" style={{ marginTop: 14 }}><span className="settings-form-hint">{setup.where}</span><CopyText value={setup.snippet} label={`Copy ${setup.label} setup`} /></div>
        <pre className="setup-code setup-code-short"><code>{setup.snippet}</code></pre>
        {setup.note && <p className="settings-footnote">{setup.note}</p>}
        <div className="settings-form-footer"><button className="ck-button ck-button-secondary" type="button" onClick={() => setCreated(null)}>Done</button></div>
      </div>
    </Panel>}

    <Panel title="New token">
      <div className="settings-card-body">
        <div className="settings-form">
          <div className="settings-form-grid">
            <div className="settings-form-field"><label htmlFor="agent-token-name">Name</label><input id="agent-token-name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="Claude Code on my laptop" onKeyDown={(event) => { if (event.key === "Enter") void create(); }} /></div>
            <div className="settings-form-field"><label htmlFor="agent-token-expiry">Expires</label><select id="agent-token-expiry" value={expiry} onChange={(event) => setExpiry(event.target.value)}><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option><option value="never">Never</option></select></div>
            {projects.length > 1 && <div className="settings-form-field full"><span className="settings-form-field-label" id="agent-token-projects-label">Projects</span><div className="settings-assignment-list" aria-labelledby="agent-token-projects-label">{projects.map((project) => <button className={`settings-assignment ${projectIds.includes(project.id) ? "selected" : ""}`} type="button" key={project.id} aria-pressed={projectIds.includes(project.id)} onClick={() => setProjectIds((current) => current.includes(project.id) ? current.filter((id) => id !== project.id) : [...current, project.id])}>{project.name}</button>)}</div><small>{projectIds.length === 0 ? "All your projects." : `${projectIds.length} project${projectIds.length === 1 ? "" : "s"} selected`}</small></div>}
          </div>
          <div className="settings-form-footer"><button className="ck-button ck-button-primary" type="button" onClick={() => void create()} disabled={creating || !name.trim()}><Plus size={13} /> {creating ? "Creating" : "Create token"}</button></div>
        </div>
      </div>
    </Panel>

    <Panel title="Your tokens">
      <div className="settings-card-body">
        {loading ? <LoadingRows count={2} columns={4} /> : tokens.length === 0 ? <div className="settings-empty">No tokens yet.</div> : <div className="settings-table-wrap"><table className="settings-table"><thead><tr><th>Name</th><th>Projects</th><th>Last used</th><th>Expires</th><th /></tr></thead><tbody>
          {tokens.map((token) => <tr key={token.id}>
            <td className="primary">{token.name}{token.hint && <div className="muted mono">ck_pat_…{token.hint}</div>}</td>
            <td>{token.projectIds && token.projectIds.length > 0 ? token.projectIds.map(projectName).join(", ") : "All your projects"}</td>
            <td>{token.lastUsedAt ? formatDateTime(token.lastUsedAt) : "Never"}</td>
            <td>{token.expiresAt ? formatDateTime(token.expiresAt) : "Never"}</td>
            <td className="actions">{confirmingId === token.id
              ? <><button className="ck-button ck-button-danger sm" type="button" onClick={() => void revoke(token.id)}>Revoke</button><button className="ck-button ck-button-quiet sm" type="button" onClick={() => setConfirmingId(null)}>Cancel</button></>
              : <button className="settings-icon-button" type="button" onClick={() => setConfirmingId(token.id)} aria-label={`Revoke ${token.name}`}><Trash2 size={13} /></button>}</td>
          </tr>)}
        </tbody></table></div>}
        {list?.mcpUrl && <p className="settings-footnote" style={{ marginTop: 12 }}>MCP endpoint: <code>{list.mcpUrl}</code></p>}
      </div>
    </Panel>
  </>;
}
