/** Setup for each coding agent that can use CostKey's MCP endpoint. */

export type AgentClient = "claude" | "cursor" | "codex" | "vscode";

export interface AgentSetup {
  id: AgentClient;
  label: string;
  /** Where the snippet goes. */
  where: string;
  snippet: string;
  /** One plain line after the snippet, when the client needs it. */
  note?: string;
}

export const AGENT_CLIENTS: Array<{ id: AgentClient; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "vscode", label: "VS Code" },
];

/** The snippets for one token and this server's MCP URL. */
export function agentSetups(mcpUrl: string, token: string): AgentSetup[] {
  return [
    {
      id: "claude",
      label: "Claude Code",
      where: "Run in your terminal",
      snippet: `claude mcp add --transport http costkey ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    },
    {
      id: "cursor",
      label: "Cursor",
      where: "~/.cursor/mcp.json",
      snippet: JSON.stringify({ mcpServers: { costkey: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
      note: "In a repository's .cursor/mcp.json, write Bearer ${env:COSTKEY_TOKEN} instead of the token.",
    },
    {
      id: "codex",
      label: "Codex",
      where: "~/.codex/config.toml",
      snippet: `[mcp_servers.costkey]\nurl = "${mcpUrl}"\nbearer_token_env_var = "COSTKEY_TOKEN"`,
      note: `Then set the token where Codex runs: export COSTKEY_TOKEN=${token}`,
    },
    {
      id: "vscode",
      label: "VS Code",
      where: ".vscode/mcp.json",
      snippet: JSON.stringify({
        inputs: [{ type: "promptString", id: "costkey-token", description: "CostKey token", password: true }],
        servers: { costkey: { type: "http", url: mcpUrl, headers: { Authorization: "Bearer ${input:costkey-token}" } } },
      }, null, 2),
      note: "VS Code asks for the token the first time it starts the server.",
    },
  ];
}

/** An expiry choice as a date, or null for none. */
export function expiryDate(choice: string, now = new Date()): string | null {
  const days = Number(choice);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}
