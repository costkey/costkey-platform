import { describe, expect, it } from "vitest";
import { agentSetups, expiryDate } from "./agentSetup";

describe("coding agent setup", () => {
  const url = "https://costkey.example.com/costkey/mcp";
  const token = "ck_pat_example";
  const setups = Object.fromEntries(agentSetups(url, token).map((setup) => [setup.id, setup]));

  it("gives Claude Code one command with this server's URL and the token", () => {
    expect(setups.claude.snippet).toBe(`claude mcp add --transport http costkey ${url} --header "Authorization: Bearer ${token}"`);
  });

  it("writes valid JSON for Cursor and VS Code", () => {
    expect(JSON.parse(setups.cursor.snippet)).toEqual({ mcpServers: { costkey: { url, headers: { Authorization: `Bearer ${token}` } } } });
    const vscode = JSON.parse(setups.vscode.snippet);
    expect(vscode.servers.costkey).toEqual({ type: "http", url, headers: { Authorization: "Bearer ${input:costkey-token}" } });
    expect(setups.vscode.snippet).not.toContain(token);
  });

  it("keeps the token out of Codex's config file", () => {
    expect(setups.codex.snippet).toBe(`[mcp_servers.costkey]\nurl = "${url}"\nbearer_token_env_var = "COSTKEY_TOKEN"`);
    expect(setups.codex.note).toContain(token);
  });

  it("turns an expiry choice into a date", () => {
    const now = new Date("2026-10-14T00:00:00Z");
    expect(expiryDate("30", now)).toBe("2026-11-13T00:00:00.000Z");
    expect(expiryDate("never", now)).toBeNull();
  });
});
