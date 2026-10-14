/**
 * The MCP endpoint: coding agents (Claude Code, Cursor, Codex, VS Code) read
 * a project's calls, runs, errors and costs at POST /mcp with a personal
 * access token. Stateless Streamable HTTP: each request gets its own server
 * and transport, so any instance behind a load balancer can answer.
 */
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { apiTokenFromHeader, mcpEnabled, type ApiTokenContext, type ApiTokenUser } from "../api-tokens.js";
import { normalizeRole } from "../permissions.js";
import { publicAppUrl } from "../public-url.js";
import { createRestClient, loopbackOrigin } from "./client.js";
import { registerTools, SERVER_INSTRUCTIONS } from "./tools.js";

const SERVER_VERSION = process.env["COSTKEY_VERSION"] || "dev";

function rpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

export function createMcpRouter(): Router {
  const router = createRouter();

  router.all("/mcp", async (req: Request, res: Response) => {
    if (!mcpEnabled()) { res.status(404).json({ error: "The MCP endpoint is turned off on this server" }); return; }
    const token = apiTokenFromHeader(req.headers.authorization);
    const apiToken = (req as Request & { apiToken?: ApiTokenContext }).apiToken;
    const user = (req as Request & { user?: ApiTokenUser }).user;
    if (!token || !apiToken || !user) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="CostKey"');
      rpcError(res, 401, "Use a CostKey access token: create one in Settings, Coding agents, and send it as Authorization: Bearer ck_pat_...");
      return;
    }
    if (req.method !== "POST") {
      // Stateless: no server-initiated stream and no session to delete.
      res.setHeader("Allow", "POST");
      rpcError(res, 405, "Method not allowed");
      return;
    }
    const server = new McpServer(
      { name: "costkey", title: "CostKey", version: SERVER_VERSION },
      { instructions: SERVER_INSTRUCTIONS },
    );
    registerTools(server, {
      api: createRestClient(loopbackOrigin(req), token),
      role: normalizeRole(user.role),
      appUrl: publicAppUrl(),
      tokenProjectIds: apiToken.projectIds,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[costkey] MCP request error:", error);
      if (!res.headersSent) rpcError(res, 500, "Internal server error");
    }
  });

  return router;
}
