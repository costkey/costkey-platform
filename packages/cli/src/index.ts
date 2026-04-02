#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { resolve, basename, relative } from "node:path";
import { globSync } from "node:fs";

const args = process.argv.slice(2);
const command = args[0];

const HELP = `
  costkey — Sentry for AI costs

  Usage:
    costkey init                        Create a new project and get your DSN
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
    --help                   Show this help
    --version                Show version
`;

const VERSION = "0.1.0";

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

// ── Existing commands ──

async function initProject(host: string) {
  const name = args[1] ?? "my-app";
  console.log(`\n  Creating project "${name}"...\n`);

  try {
    const res = await fetch(`${host}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`  Error: ${(err as Record<string, string>).error ?? res.statusText}`);
      process.exit(1);
    }

    const project = (await res.json()) as {
      id: string; name: string; authKey: string; dsn: string;
    };

    console.log(`  Project created!`);
    console.log();
    console.log(`  Project ID:  ${project.id}`);
    console.log(`  Auth Key:    ${project.authKey}`);
    console.log(`  DSN:         ${project.dsn}`);
    console.log();
    console.log(`  Add this to your app:`);
    console.log();
    console.log(`    import { CostKey } from 'costkey'`);
    console.log(`    CostKey.init({ dsn: '${project.dsn}' })`);
    console.log();
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
  try {
    const res = await fetch(`${host}/api/v1/projects`);
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
