#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, basename, relative, join } from "node:path";
import { globSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const command = args[0];

const HELP = `
  costkey — Sentry for AI costs

  Usage:
    costkey init [name]                 Create a new project and get your DSN
    costkey login                       Authenticate with CostKey
    costkey status                      Check connection to CostKey server
    costkey projects                    List all projects
    costkey sourcemaps upload           Upload sourcemaps for a release

  Sourcemap Upload:
    costkey sourcemaps upload --release <version> --auth-key <key> <glob>

    Options:
      --release <version>    Release version (e.g., v1.2.3, git SHA)
      --auth-key <key>       Project auth key (ck_...)
      --host <url>           Server URL (default: https://app.costkey.dev)

    Examples:
      costkey sourcemaps upload --release v1.2.3 --auth-key ck_abc123 ./dist/**/*.map
      costkey sourcemaps upload --release $(git rev-parse --short HEAD) --auth-key $COSTKEY_KEY ./build/*.map

  Options:
    --host <url>             Server URL (default: https://app.costkey.dev)
    --token <token>          CLI auth token (for CI/headless environments)
    --help                   Show this help
    --version                Show version
`;

const VERSION = "0.1.0";
const TOKEN_DIR = join(process.env["HOME"] ?? "~", ".costkey");
const TOKEN_FILE = join(TOKEN_DIR, "token");

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function getHost(): string {
  return getArg("--host") ?? process.env["COSTKEY_HOST"] ?? "https://app.costkey.dev";
}

async function main() {
  if (!command || command === "--help" || command === "help") {
    console.log(HELP);
    return;
  }

  if (command === "--version" || command === "version") {
    console.log(VERSION);
    return;
  }

  const host = getHost();

  switch (command) {
    case "init":
      await initProject(host);
      break;
    case "login":
      await login(host);
      break;
    case "status":
      await checkStatus(host);
      break;
    case "projects":
      await listProjects(host);
      break;
    case "sourcemaps":
      await handleSourcemaps(host);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

// ── Sourcemaps ──

async function handleSourcemaps(host: string) {
  const subcommand = args[1];
  if (subcommand !== "upload") {
    console.error(`  Unknown sourcemaps subcommand: ${subcommand}`);
    console.log(`  Usage: costkey sourcemaps upload --release <version> --auth-key <key> <glob>`);
    process.exit(1);
  }

  const release = getArg("--release");
  const authKey = getArg("--auth-key") ?? process.env["COSTKEY_AUTH_KEY"];

  if (!release) {
    console.error("  Missing --release flag");
    process.exit(1);
  }
  if (!authKey) {
    console.error("  Missing --auth-key flag (or set COSTKEY_AUTH_KEY env var)");
    process.exit(1);
  }

  // Collect .map file paths from remaining args (skip flags)
  const fileArgs: string[] = [];
  for (let i = 2; i < args.length; i++) {
    if (args[i].startsWith("--")) { i++; continue; } // skip flag + value
    fileArgs.push(args[i]);
  }

  if (fileArgs.length === 0) {
    console.error("  No sourcemap files specified");
    console.log(`  Usage: costkey sourcemaps upload --release ${release} --auth-key <key> ./dist/**/*.map`);
    process.exit(1);
  }

  // Resolve file paths (handle globs manually since shell might not expand them)
  const files: string[] = [];
  for (const pattern of fileArgs) {
    const resolved = resolve(pattern);
    if (existsSync(resolved)) {
      files.push(resolved);
    } else {
      // Try as a literal path
      console.warn(`  Warning: ${pattern} not found, skipping`);
    }
  }

  if (files.length === 0) {
    console.error("  No .map files found");
    process.exit(1);
  }

  console.log(`\n  Uploading ${files.length} sourcemap${files.length > 1 ? "s" : ""} for release "${release}"...\n`);

  let uploaded = 0;
  let failed = 0;

  for (const filePath of files) {
    const mapContent = readFileSync(filePath, "utf-8");

    // Parse the sourcemap to find the source file it maps
    let sourceFileName: string;
    try {
      const parsed = JSON.parse(mapContent);
      // The "file" field in the sourcemap points to the generated file
      sourceFileName = parsed.file ?? basename(filePath).replace(/\.map$/, "");
    } catch {
      sourceFileName = basename(filePath).replace(/\.map$/, "");
    }

    try {
      const res = await fetch(`${host}/api/v1/sourcemaps`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authKey}`,
        },
        body: JSON.stringify({
          release,
          fileName: sourceFileName,
          sourcemapJson: mapContent,
        }),
      });

      if (res.ok) {
        console.log(`  ✓ ${relative(process.cwd(), filePath)} → ${sourceFileName}`);
        uploaded++;
      } else {
        const err = await res.json().catch(() => ({}));
        console.error(`  ✗ ${relative(process.cwd(), filePath)}: ${(err as Record<string, string>).error ?? res.statusText}`);
        failed++;
      }
    } catch (err) {
      console.error(`  ✗ ${relative(process.cwd(), filePath)}: ${err}`);
      failed++;
    }
  }

  console.log(`\n  Done: ${uploaded} uploaded, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── Token management ──

function loadToken(): string | null {
  // CLI flag takes precedence
  const flagToken = getArg("--token");
  if (flagToken) return flagToken;
  // Then env var
  if (process.env["COSTKEY_TOKEN"]) return process.env["COSTKEY_TOKEN"];
  // Then stored token file
  try {
    if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf-8").trim();
  } catch { /* ignore */ }
  return null;
}

function saveToken(token: string): void {
  try {
    mkdirSync(TOKEN_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch (err) {
    console.warn(`  Warning: could not save token to ${TOKEN_FILE}: ${err}`);
  }
}

// ── Browser OAuth login ──

async function login(host: string): Promise<string> {
  // Check for existing token
  const existing = loadToken();
  if (existing) {
    // Verify it's still valid
    try {
      const res = await fetch(`${host}/auth/me`, {
        headers: { Authorization: `Bearer ${existing}` },
      });
      if (res.ok) {
        const data = await res.json() as { authenticated: boolean; user?: { email: string } };
        if (data.authenticated) {
          console.log(`\n  Already logged in as ${data.user?.email}\n`);
          return existing;
        }
      }
    } catch { /* token invalid, proceed to login */ }
  }

  console.log(`\n  Opening browser to log in...\n`);

  const state = randomBytes(16).toString("hex");

  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      if (req.method === "POST" && req.url === "/callback") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          try {
            const { token: receivedToken, state: receivedState } = JSON.parse(body) as { token: string; state: string };
            if (receivedState !== state) {
              res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
              res.end(JSON.stringify({ error: "State mismatch" }));
              return;
            }

            saveToken(receivedToken);
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify({ ok: true }));

            console.log(`  Logged in successfully! Token saved to ${TOKEN_FILE}\n`);

            server.close();
            resolve(receivedToken);
          } catch {
            res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ error: "Invalid request" }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      const loginUrl = `${host}/auth/cli?port=${port}&state=${state}`;

      // Try to open the browser
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      import("node:child_process").then(({ exec }) => {
        exec(`${openCmd} "${loginUrl}"`, (err) => {
          if (err) {
            console.log(`  Could not open browser automatically.`);
            console.log(`  Open this URL in your browser:\n`);
            console.log(`    ${loginUrl}\n`);
          }
        });
      });

      console.log(`  Waiting for authentication...\n`);
      console.log(`  If the browser didn't open, visit:\n    ${loginUrl}\n`);

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error("Login timed out after 5 minutes"));
      }, 5 * 60 * 1000);
    });

    server.on("error", (err) => {
      console.error(`  Could not start local auth server: ${err}`);
      reject(err);
    });
  });
}

// ── Provider detection ──

function detectProvider(): { name: string; lang: "ts" | "py" } | null {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as Record<string, Record<string, string>>;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps["openai"]) return { name: "OpenAI", lang: "ts" };
    if (allDeps["@anthropic-ai/sdk"]) return { name: "Anthropic", lang: "ts" };
    if (allDeps["@google/genai"]) return { name: "Google AI", lang: "ts" };
    if (allDeps["groq-sdk"]) return { name: "Groq", lang: "ts" };
  } catch { /* no package.json */ }

  // Check for Python
  try {
    const reqs = readFileSync("requirements.txt", "utf-8");
    if (reqs.includes("openai")) return { name: "OpenAI", lang: "py" };
    if (reqs.includes("anthropic")) return { name: "Anthropic", lang: "py" };
    if (reqs.includes("google-genai")) return { name: "Google AI", lang: "py" };
  } catch { /* no requirements.txt */ }

  try {
    const pyproject = readFileSync("pyproject.toml", "utf-8");
    if (pyproject.includes("openai")) return { name: "OpenAI", lang: "py" };
    if (pyproject.includes("anthropic")) return { name: "Anthropic", lang: "py" };
  } catch { /* no pyproject.toml */ }

  return null;
}

// ── Init command ──

async function initProject(host: string) {
  // Step 1: Ensure we have auth
  let token = loadToken();
  if (!token) {
    console.log("  Not logged in. Let's fix that.\n");
    token = await login(host);
  }

  const name = args[1] ?? "my-app";
  console.log(`  Creating project "${name}"...\n`);

  try {
    const res = await fetch(`${host}/api/v1/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name }),
    });

    if (res.status === 401 || res.status === 403) {
      console.error(`  Authentication failed. Run \`costkey login\` to re-authenticate.`);
      process.exit(1);
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`  Error: ${(err as Record<string, string>).error ?? res.statusText}`);
      process.exit(1);
    }

    const project = (await res.json()) as {
      id: string; name: string; authKey: string; dsn: string;
    };

    console.log(`  Project created!\n`);
    console.log(`  DSN:  ${project.dsn}\n`);

    // Step 2: Detect provider and show appropriate snippet
    const provider = detectProvider();

    if (provider?.lang === "py") {
      console.log(`  Detected ${provider.name} (Python). Add this to your app:\n`);
      console.log(`    import costkey`);
      console.log(`    costkey.init(dsn="${project.dsn}")\n`);
    } else {
      console.log(`  ${provider ? `Detected ${provider.name}. ` : ""}Add this to your app:\n`);
      console.log(`    import { CostKey } from 'costkey'`);
      console.log(`    CostKey.init({ dsn: '${project.dsn}' })\n`);
    }

    // Step 3: Offer to write to .env
    if (existsSync(".env")) {
      const envContent = readFileSync(".env", "utf-8");
      if (!envContent.includes("COSTKEY_DSN")) {
        try {
          appendFileSync(".env", `\n# CostKey\nCOSTKEY_DSN=${project.dsn}\n`);
          console.log(`  Added COSTKEY_DSN to .env\n`);
        } catch {
          console.log(`  Tip: add this to your .env:\n    COSTKEY_DSN=${project.dsn}\n`);
        }
      }
    } else {
      console.log(`  Tip: add to your .env:\n    COSTKEY_DSN=${project.dsn}\n`);
    }

    console.log(`  Open your dashboard: ${host}\n`);
  } catch {
    console.error(`  Could not connect to ${host}`);
    process.exit(1);
  }
}

async function checkStatus(host: string) {
  console.log(`\n  Checking ${host}...\n`);
  try {
    const res = await fetch(`${host}/health`);
    const data = (await res.json()) as { status: string; version: string };
    console.log(`  Status:   ${data.status}`);
    console.log(`  Version:  ${data.version}`);
    console.log();
  } catch {
    console.error(`  Could not connect to ${host}`);
    process.exit(1);
  }
}

async function listProjects(host: string) {
  const token = loadToken();
  if (!token) {
    console.error("  Not logged in. Run `costkey login` first.");
    process.exit(1);
  }

  try {
    const res = await fetch(`${host}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as {
      projects: Array<{ id: string; name: string; event_count: number; total_cost: number }>;
    };

    if (data.projects.length === 0) {
      console.log("\n  No projects yet. Run `costkey init <name>` to create one.\n");
      return;
    }

    console.log(`\n  Projects:\n`);
    for (const p of data.projects) {
      console.log(`  ${p.name.padEnd(20)} ${p.id.padEnd(30)} ${String(p.event_count).padStart(6)} events  $${p.total_cost.toFixed(2)}`);
    }
    console.log();
  } catch {
    console.error(`  Could not connect to ${host}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
