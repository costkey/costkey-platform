#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

const HELP = `
  costkey — Sentry for AI costs

  Usage:
    costkey init           Create a new project and get your DSN
    costkey status         Check connection to CostKey server
    costkey projects       List all projects

  Options:
    --host <url>           Server URL (default: http://localhost:4100)
    --help                 Show this help
    --version              Show version
`;

const VERSION = "0.0.1";

function getHost(): string {
  const idx = args.indexOf("--host");
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return process.env["COSTKEY_HOST"] ?? "http://localhost:4100";
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
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

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
      id: string;
      name: string;
      authKey: string;
      dsn: string;
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
    console.log();
    console.log(`    CostKey.init({`);
    console.log(`      dsn: '${project.dsn}'`);
    console.log(`    })`);
    console.log();
  } catch (err) {
    console.error(`  Could not connect to ${host}`);
    console.error(`  Is the CostKey server running?`);
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
      projects: Array<{
        id: string;
        name: string;
        event_count: number;
        total_cost: number;
      }>;
    };

    if (data.projects.length === 0) {
      console.log("\n  No projects yet. Run `costkey init <name>` to create one.\n");
      return;
    }

    console.log(`\n  Projects:\n`);
    for (const p of data.projects) {
      const cost = p.total_cost >= 1 ? `$${p.total_cost.toFixed(2)}` : `$${p.total_cost.toFixed(4)}`;
      console.log(`  ${p.name.padEnd(20)} ${p.id.padEnd(30)} ${String(p.event_count).padStart(6)} events  ${cost}`);
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
