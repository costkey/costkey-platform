import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import {
  apiTokenGuards,
  apiTokenRouteAllowed,
  generateApiToken,
  hashApiToken,
  isApiTokenHeader,
  mcpEnabled,
  projectIdFromPath,
  stripIngestSecrets,
} from "../api-tokens.js";
import { conversationFrom, renderConversation, renderFrame, responseText, stripBinary, trim, usd } from "../mcp/format.js";
import { buildRunTree, callFailure, firstFailure, timeWindow } from "../mcp/tools.js";
import { queryString } from "../mcp/client.js";
import { relativeFile } from "../charge-cohort.js";

test("a token is ck_pat_ plus 256 random bits, stored only as its SHA-256", () => {
  const token = generateApiToken();
  assert.match(token, /^ck_pat_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(generateApiToken(), token);
  assert.equal(hashApiToken(token), createHash("sha256").update(token).digest("hex"));
  assert.notEqual(hashApiToken(token), token);
  assert.equal(isApiTokenHeader(`Bearer ${token}`), true);
  assert.equal(isApiTokenHeader("Bearer eyJhbGciOi.jwt.token"), false);
  assert.equal(isApiTokenHeader(undefined), false);
});

test("a token may only read projects and use the MCP endpoint", () => {
  assert.equal(apiTokenRouteAllowed("GET", "/api/v1/projects"), true);
  assert.equal(apiTokenRouteAllowed("GET", "/api/v1/projects/p1/events"), true);
  assert.equal(apiTokenRouteAllowed("HEAD", "/api/v1/projects/p1"), true);
  assert.equal(apiTokenRouteAllowed("POST", "/mcp"), true);
  assert.equal(apiTokenRouteAllowed("POST", "/api/v1/projects"), false);
  assert.equal(apiTokenRouteAllowed("PATCH", "/api/v1/projects/p1"), false);
  assert.equal(apiTokenRouteAllowed("DELETE", "/api/v1/projects/p1"), false);
  assert.equal(apiTokenRouteAllowed("POST", "/api/v1/projects/p1/rotate-key"), false);
  assert.equal(apiTokenRouteAllowed("GET", "/api/v1/agent-tokens"), false);
  assert.equal(apiTokenRouteAllowed("POST", "/api/v1/agent-tokens"), false);
  assert.equal(apiTokenRouteAllowed("GET", "/auth/me"), false);
  assert.equal(apiTokenRouteAllowed("GET", "/api/v1/workspace/settings"), false);
  assert.equal(apiTokenRouteAllowed("GET", "/api/v1/projectsx"), false);
  assert.equal(projectIdFromPath("/api/v1/projects/proj%201/events"), "proj 1");
  assert.equal(projectIdFromPath("/api/v1/projects"), null);
});

test("ingest keys and DSNs never reach a token", () => {
  assert.deepEqual(
    stripIngestSecrets({ projects: [{ id: "p", authKey: "ck_x", dsn: "https://ck_x@h/p", nested: { auth_key: "k", name: "n" } }] }),
    { projects: [{ id: "p", nested: { name: "n" } }] },
  );
});

test("the MCP endpoint is on unless COSTKEY_MCP_ENABLED turns it off", () => {
  const saved = process.env["COSTKEY_MCP_ENABLED"];
  try {
    delete process.env["COSTKEY_MCP_ENABLED"];
    assert.equal(mcpEnabled(), true);
    for (const off of ["false", "0", "off", "NO"]) { process.env["COSTKEY_MCP_ENABLED"] = off; assert.equal(mcpEnabled(), false); }
    process.env["COSTKEY_MCP_ENABLED"] = "true";
    assert.equal(mcpEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env["COSTKEY_MCP_ENABLED"]; else process.env["COSTKEY_MCP_ENABLED"] = saved;
  }
});

test("each token has its own read limit", async () => {
  const app = express();
  app.use((req, _res, next) => {
    const id = req.headers["x-token"];
    if (typeof id === "string") (req as unknown as { apiToken: unknown }).apiToken = { id, name: id, scopes: ["read"], projectIds: null };
    next();
  });
  app.use(apiTokenGuards({ max: 2 }));
  app.get("/api/v1/projects", (_req, res) => { res.json({ projects: [{ id: "p", authKey: "secret" }] }); });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const get = (token?: string) => fetch(`http://127.0.0.1:${address.port}/api/v1/projects`, { headers: token ? { "x-token": token } : {} });
  try {
    const first = await get("a");
    assert.deepEqual(await first.json(), { projects: [{ id: "p" }] });
    assert.equal((await get("a")).status, 200);
    assert.equal((await get("a")).status, 429);
    assert.equal((await get("b")).status, 200, "another token has its own budget");
    for (let i = 0; i < 4; i++) assert.equal((await get()).status, 200, "session requests are not limited here");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("file filters take repo-relative paths", () => {
  assert.equal(relativeFile("./src/agents/summarize.ts"), "src/agents/summarize.ts");
  assert.equal(relativeFile("/app/src/x.py"), "app/src/x.py");
  assert.equal(relativeFile("src\\win\\path.ts"), "src/win/path.ts");
});

test("a time window from since, or from and to", () => {
  const window = timeWindow({ since: "10m" }, "24h");
  const span = Date.parse(window.to) - Date.parse(window.from);
  assert.ok(Math.abs(span - 11 * 60_000) < 1000, "ten minutes back, a minute ahead");
  assert.equal(window.label, "last 10m");
  assert.equal(timeWindow({}, "7d").label, "last 7d");
  const fixed = timeWindow({ from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" }, "24h");
  assert.equal(fixed.from, "2026-10-01T00:00:00.000Z");
  assert.throws(() => timeWindow({ since: "yesterday" }, "24h"), /since must look like/);
  assert.throws(() => timeWindow({ from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }, "24h"), /before/);
  assert.equal(queryString({ a: "1", b: undefined, c: [1, 2], d: "" }), "?a=1&c=1&c=2");
});

test("a call's failure reads the same as in the console", () => {
  assert.equal(callFailure({ status_code: 200 }), null);
  assert.equal(callFailure({ status_code: 429 }), "FAILED: Rate limited (429)");
  assert.equal(callFailure({ lifecycle_state: "failed", lifecycle_error_type: "ReadTimeout", duration_ms: 10100 }), "FAILED: Timed out after 10.1s");
  assert.equal(callFailure({ lifecycle_state: "cancelled" }), "CANCELLED");
  assert.equal(usd(0.00123), "$0.0012");
  assert.equal(usd(12.5), "$12.50");
  assert.equal(usd(null), "unpriced");
});

test("prompts read as a system prompt and the last messages, binary stripped", () => {
  const openAi = conversationFrom({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You summarize." },
      ...Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `message ${index}` })),
      { role: "user", content: [{ type: "text", text: "Look:" }, { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(5000)}` } }] },
    ],
  });
  assert.ok(openAi);
  assert.equal(openAi.system, "You summarize.");
  assert.equal(openAi.messages.length, 9);
  const rendered = renderConversation(openAi, 2000, 3);
  assert.match(rendered, /^\[system\] You summarize\./);
  assert.match(rendered, /6 earlier messages omitted/);
  assert.match(rendered, /\[user\] Look:\n\[image\]/);
  assert.doesNotMatch(rendered, /AAAA/);

  const anthropic = conversationFrom({ system: [{ type: "text", text: "Be brief." }], messages: [{ role: "user", content: [{ type: "tool_result", content: "42" }] }] });
  assert.equal(anthropic?.system, "Be brief.");
  assert.match(anthropic?.messages[0]?.text ?? "", /tool result\] 42/);

  const gemini = conversationFrom({ systemInstruction: { parts: [{ text: "Sys" }] }, contents: [{ role: "user", parts: [{ text: "Hi" }, { inlineData: { mimeType: "image/jpeg", data: "B".repeat(900) } }] }] });
  assert.equal(gemini?.system, "Sys");
  assert.equal(gemini?.messages[0]?.text, "Hi\n[image image/jpeg]");

  assert.equal(conversationFrom(null, null, { prompts: [{ role: "user", content: "from metadata" }] })?.messages[0]?.text, "from metadata");
  assert.equal(conversationFrom(null), null);
  assert.match(stripBinary(`see data:audio/wav;base64,${"Q".repeat(2000)} here`), /\[audio\/wav base64, \d+ KB omitted\] here/);
  assert.match(trim("x".repeat(500), 100), /more chars\]$/);
});

test("responses read as the answer, or the provider's error", () => {
  assert.equal(responseText({ choices: [{ message: { content: "Done." }, finish_reason: "stop" }] }), "Done.");
  assert.equal(responseText({ choices: [{ message: { content: null, tool_calls: [{ function: { name: "search", arguments: "{\"q\":1}" } }] }, finish_reason: "tool_calls" }] }), "[tool call search({\"q\":1})]\n[finish_reason: tool_calls]");
  assert.equal(responseText({ content: [{ type: "text", text: "Hi" }], stop_reason: "max_tokens" }), "Hi\n[stop_reason: max_tokens]");
  assert.equal(responseText({ error: { type: "rate_limit_error", message: "Slow down" } }), "[error rate_limit_error] Slow down");
  assert.equal(responseText({ candidates: [{ content: { parts: [{ text: "G" }] }, finishReason: "STOP" }] }), "G");
  assert.equal(responseText({ output: [{ type: "message", content: [{ type: "output_text", text: "R" }] }] }), "R");
});

test("a frame shows its source with the call line marked", () => {
  const text = renderFrame({ fileName: "src/a.ts", lineNumber: 10, functionName: "run", preContext: ["const a = 1;"], contextLine: "await call();", postContext: ["return a;"] }, true);
  assert.equal(text, "src/a.ts:10 run()\n        9 | const a = 1;\n  >    10 | await call();\n       11 | return a;");
});

test("a run tree nests calls under their spans and marks where it first failed", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 14, 10, 0, seconds)).toISOString();
  const spans = [
    { id: "agent", parent_span_id: null, kind: "agent", name: "writer", status: "error", started_at: at(0) },
    { id: "tool", parent_span_id: "agent", kind: "tool", name: "search", status: "ok", started_at: at(1) },
  ];
  const calls = [
    { id: "c1", span_id: "agent", timestamp: at(0.5), status_code: 200, cost_usd: 0.01 },
    { id: "c2", span_id: "tool", timestamp: at(2), status_code: 500, cost_usd: null },
    { id: "c3", span_id: null, timestamp: at(3), status_code: 200, cost_usd: null },
  ];
  const roots = buildRunTree(spans, calls);
  assert.deepEqual(roots.map((node) => node.id), ["agent", "c3"]);
  assert.deepEqual(roots[0]!.children.map((node) => node.id), ["c1", "tool"]);
  assert.equal(roots[0]!.cost, 0.01);
  assert.equal(roots[1]!.unpriced, 1);
  assert.equal(firstFailure(roots)?.id, "c2", "the agent errored because its tool's call did");
});

test("tools loop back to this server on 127.0.0.1, never the request's local address", async () => {
  const { loopbackOrigin } = await import("../mcp/client.js");
  // Behind Cloud Run the request arrives on the sandbox interface, which can't be dialled back.
  const req = { socket: { localAddress: "169.254.8.1", localPort: 4100 } } as never;
  assert.equal(loopbackOrigin(req), "http://127.0.0.1:4100");
});
