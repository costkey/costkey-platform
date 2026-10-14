---
id: mcp
title: Debug with coding agents (MCP)
description: Let Claude Code, Cursor, Codex and VS Code read your LLM calls, runs, errors and costs from CostKey over MCP.
---

# Debug with coding agents (MCP)

Every CostKey server has an MCP endpoint at `/mcp`. A coding agent connected to it can read what your app's LLM calls did, while it works on the code that made them:

- "What did `src/agents/summarize.ts` call in the last 5 minutes, and why did it fail?"
- "Show run `tr_…` as a tree. Where did it first go wrong?"
- "Did my change make the summarizer more expensive?"

It works the same on CostKey Cloud (`https://app.costkey.dev/mcp`) and on a self-hosted server (`<PUBLIC_URL>/mcp`). The agent reads with a token you create. It can't change anything.

## Create a token

Open **Settings, Coding agents** in the console.

1. Name the token, such as "Claude Code on my laptop".
2. Optional: pick the projects it may read. With none picked, it reads every project you can.
3. Pick when it expires: 30 days, 90 days, a year, or never.
4. Click **Create token** and copy it. It starts with `ck_pat_` and is shown once.

The console then shows the setup for each agent below with your server's address filled in.

## Connect your agent

Replace `https://app.costkey.dev` with your `PUBLIC_URL` on a self-hosted server.

### Claude Code

```bash
claude mcp add --transport http costkey https://app.costkey.dev/mcp \
  --header "Authorization: Bearer ck_pat_..."
```

To share the setup with your team in the repository, run `npx costkey mcp` in the project. It writes a `.mcp.json` that reads the token from `COSTKEY_TOKEN`, so the file is safe to commit:

```json
{
  "mcpServers": {
    "costkey": {
      "type": "http",
      "url": "https://app.costkey.dev/mcp",
      "headers": { "Authorization": "Bearer ${COSTKEY_TOKEN}" }
    }
  }
}
```

Each person then sets their own token with `export COSTKEY_TOKEN=ck_pat_...`.

### Cursor

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "costkey": {
      "url": "https://app.costkey.dev/mcp",
      "headers": { "Authorization": "Bearer ck_pat_..." }
    }
  }
}
```

In a repository's `.cursor/mcp.json`, write `Bearer ${env:COSTKEY_TOKEN}` instead of the token.

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.costkey]
url = "https://app.costkey.dev/mcp"
bearer_token_env_var = "COSTKEY_TOKEN"
```

Then set `COSTKEY_TOKEN` where Codex runs.

### VS Code

In `.vscode/mcp.json`. VS Code asks for the token the first time it starts the server:

```json
{
  "inputs": [
    { "type": "promptString", "id": "costkey-token", "description": "CostKey token", "password": true }
  ],
  "servers": {
    "costkey": {
      "type": "http",
      "url": "https://app.costkey.dev/mcp",
      "headers": { "Authorization": "Bearer ${input:costkey-token}" }
    }
  }
}
```

## Tools

Every tool takes an optional `project`, by name or id. Leave it out when the token can read one project. Answers are short text, with `file:line` where it is known and a console link for each item. The ids in one answer (call ids, run ids) are what the other tools take.

| Tool | What it answers | Ask, for example |
| --- | --- | --- |
| `list_projects` | The projects the token can read, and whether each captures prompts and responses. | "Which CostKey projects can you see?" |
| `find_calls` | LLM calls in a time window, filtered by source file, function, feature, model, provider, environment, release, status or run. Newest, most expensive or slowest first. | "What did src/agents/summarize.ts call in the last 5 minutes?" "Which calls returned 429 today?" |
| `get_call` | One call: model, status and error, tokens, cost and how it was priced, latency and time to first token, retries, the stack of your code with its source lines, and the prompt and response. | "Why did call 0767a9… fail? Show the prompt." |
| `find_runs` | Runs (one execution of an agent, workflow or job), with status, duration, calls and cost. `failed_only` for runs that went wrong. | "Which research-agent runs failed in the last hour?" |
| `get_run` | One run as a tree, agent, step, tool and call, with each node's status, duration and cost, the first failure marked, and its quality check results. | "Show run tr_5bn… as a tree." |
| `recent_errors` | What is failing: failed calls by model and HTTP status, failed steps and tools, failing agents and workflows, and the latest failed runs and calls. | "What's been failing since this morning?" |
| `cost_breakdown` | Spend by feature, function, model, provider, release or customer, against the period just before. | "Did release 1.4.2 make it more expensive?" "Which feature costs the most this week?" |
| `hot_call_sites` | The lines of code that make LLM calls, by total cost, latency or call count. | "Where in the code do we spend the most on LLM calls?" |

File filters take the path from your repository, such as `src/agents/summarize.ts` or `summarize.py`. CostKey matches the path it recorded, or its ending.

Prompts and responses are trimmed to fit: the system prompt and the last messages, with a count of the ones left out, and images and other base64 data dropped. Ask the agent to include every message, the raw request and response, or every stack frame when you need them. When a body isn't there, the answer says why: the project records metadata only, the body expired with the project's retention, privacy settings redacted it, or your role can't see it.

## Security

- **Read only.** A token can read projects and use the MCP endpoint. Every other request is refused, including any change to settings, budgets or projects. A token can't create other tokens.
- **Your access, no more.** A token reads as you, at your current role. If your role changes or you leave the workspace, your tokens follow at once. A Viewer's token gets the same redaction as the console: no prompts, responses or code. A project with code and content access turned off hides them from every token.
- **Limited to projects.** Pick projects when you create a token to keep it to those.
- **Revocable.** Revoke a token in Settings, Coding agents. It stops working on the next request. Tokens can also expire.
- **Stored as a hash.** CostKey keeps a SHA-256 hash of each token, never the token. Treat a token like a password.
- **No ingest keys.** Answers to a token never include a project's DSN or ingest key.
- **Rate limited.** Each token can make 300 reads a minute.

## Self-hosting

The endpoint is on by default at `<PUBLIC_URL>/mcp`, on the same port as the console. Nothing else to run.

- **Reachability.** Your agent connects from where it runs, usually your laptop. The server must be reachable from there at `PUBLIC_URL`, over your VPN for example. Behind Identity-Aware Proxy, route `/mcp` around IAP the way you route the SDK paths; the token authenticates it.
- **Turn it off** with `COSTKEY_MCP_ENABLED=false` in `.env`. The endpoint then answers 404 and Settings says it is off.
- **Rate limit.** Change the per-token limit with `COSTKEY_TOKEN_RATE_LIMIT`, in reads a minute.

See [Self-hosting](./self-hosting) for the other settings.
