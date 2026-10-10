/**
 * Network boundary for local acceptance.
 *
 * The server contains legacy email/webhook clients that can attempt outbound
 * requests when a fixture exercises a notification path. Loading this module
 * into every acceptance process permits loopback HTTP/PostgreSQL only and
 * throws before any non-loopback socket or fetch is opened.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isAllowedHost(host) {
  return ALLOWED_HOSTS.has(String(host ?? "").replace(/^\[|\]$/g, ""));
}

function hostFromArgs(args) {
  const first = args[0];
  if (typeof first === "number") {
    // net.connect(port) defaults to localhost; net.connect(port, host) makes
    // the destination explicit.
    return typeof args[1] === "string" ? args[1] : "127.0.0.1";
  }
  if (typeof first === "string" || first instanceof URL) {
    try { return new URL(String(first)).hostname; } catch { return ""; }
  }
  if (typeof Request !== "undefined" && first instanceof Request) {
    try { return new URL(first.url).hostname; } catch { return ""; }
  }
  if (first && typeof first === "object") {
    const explicitHost = first.hostname ?? first.host ?? first.servername;
    // Node normalizes net.connect(port, host) into an options object before
    // invoking Socket.prototype.connect. An absent host means its documented
    // localhost default, not an external destination.
    return explicitHost ?? "127.0.0.1";
  }
  return "";
}

function assertLoopback(args) {
  const host = hostFromArgs(args);
  if (!isAllowedHost(host)) {
    throw new Error("local acceptance network guard blocked non-loopback egress");
  }
}

const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function") {
  globalThis.fetch = function acceptanceFetch(input, init) {
    assertLoopback([input]);
    return originalFetch(input, init);
  };
}

for (const [module, name] of [[net, "connect"], [net, "createConnection"], [tls, "connect"], [http, "request"], [https, "request"]]) {
  const original = module[name];
  if (typeof original !== "function") continue;
  module[name] = function acceptanceNetworkGuard(...args) {
    assertLoopback(args);
    return original.apply(this, args);
  };
}

// A few clients call Socket.prototype.connect directly instead of the module
// helpers above. Guard that seam as well; internal calls that pass an already
// connected socket are safe because their network destination was checked at
// socket creation time.
const socketPrototype = net.Socket?.prototype;
const originalSocketConnect = socketPrototype?.connect;
if (typeof originalSocketConnect === "function") {
  socketPrototype.connect = function acceptanceSocketConnect(...args) {
    const first = args[0];
    const isExistingSocket = first && typeof first === "object" && (first instanceof net.Socket || "_handle" in first);
    if (!isExistingSocket) assertLoopback(args);
    return originalSocketConnect.apply(this, args);
  };
}
