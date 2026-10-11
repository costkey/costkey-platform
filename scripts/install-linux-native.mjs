#!/usr/bin/env node
/**
 * The lockfile was written on macOS, so `npm ci` on Linux misses the native
 * bindings the console build needs (an npm optional-dependency gap). Fetch
 * the Linux binding matching each installed package's exact version and
 * unpack it beside the package. Packages that already have one are skipped.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform !== "linux") process.exit(0);
const arch = { x64: "x64", arm64: "arm64" }[process.arch];
if (!arch) throw new Error(`Unsupported architecture: ${process.arch}`);
const libc = existsSync("/etc/alpine-release") ? "musl" : "gnu";

const bindings = [
  ["rolldown", `@rolldown/binding-linux-${arch}-${libc}`],
  ["rollup", `@rollup/rollup-linux-${arch}-${libc}`],
  ["esbuild", `@esbuild/linux-${arch}`],
  ["@tailwindcss/oxide", `@tailwindcss/oxide-linux-${arch}-${libc}`],
  ["lightningcss", `lightningcss-linux-${arch}-${libc}`],
];

const scratch = mkdtempSync(path.join(tmpdir(), "costkey-native-"));
for (const [parent, binding] of bindings) {
  const manifest = path.join("node_modules", parent, "package.json");
  if (!existsSync(manifest)) continue;
  const target = path.join("node_modules", binding);
  if (existsSync(path.join(target, "package.json"))) continue;
  const { version } = JSON.parse(readFileSync(manifest, "utf8"));
  const tarball = execFileSync("npm", ["pack", `${binding}@${version}`, "--pack-destination", scratch, "--silent"], { encoding: "utf8" }).trim().split("\n").pop();
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["xzf", path.join(scratch, tarball), "--strip-components=1", "-C", target]);
  console.log(`installed ${binding}@${version}`);
}
