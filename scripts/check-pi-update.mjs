#!/usr/bin/env node
/** Check a published Pi release in an isolated copy. The working package is never edited. */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1]; };
const requested = value("version", "latest");
if (!requested || !/^(latest|\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/.test(requested)) throw new Error("--version must be latest or an exact npm release.");
const stamp = new Date().toISOString().replaceAll(":", "-");
const reportFile = resolve(value("report", join(root, ".sakura", "upgrades", `${stamp}.json`)));
const candidate = await mkdtemp(join(tmpdir(), "sakura-pi-upgrade-"));
const started = Date.now();
const packageNames = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = await Promise.all(["package.json", "package-lock.json"].map(async (name) => ({ name, sha256: hash(await readFile(join(root, name))) })));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const steps = [];
async function command(args, cwd = candidate) {
  console.log(`npm ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, { cwd, env: { ...process.env, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      steps.push({ command: ["npm", ...args], exitCode: code, output });
      if (code === 0) resolve(output.trim()); else reject(new Error(`npm ${args.join(" ")} failed (${code})`));
    });
  });
}
let version;
let error;
try {
  version = JSON.parse(await command(["view", `${packageNames[0]}@${requested}`, "version", "--json"], root));
  for (const path of ["package.json", "package-lock.json", "tsconfig.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "src", "extensions", "skills", "prompts", "themes", "tests", "scripts", "docs", "templates", "benchmarks"]) {
    await cp(join(root, path), join(candidate, path), { recursive: true });
  }
  await command(["install", "--ignore-scripts", "--save-dev", "--save-exact", ...packageNames.map((name) => `${name}@${version}`)]);
  await command(["run", "check"]);
  await command(["run", "check:plugin"]);
  await command(["exec", "--", "pi", "--version"]);
  await command(["pack", "--dry-run", "--json", "--ignore-scripts"]);
} catch (caught) { error = caught.message; }
const unchanged = (await Promise.all(original.map(async (entry) => hash(await readFile(join(root, entry.name))) === entry.sha256))).every(Boolean);
const report = { checkedAt: new Date().toISOString(), requested, from: manifest.devDependencies[packageNames[0]], to: version, passed: !error && unchanged, error, durationMs: Date.now() - started, currentFilesUnchanged: unchanged, requiredSakuraChanges: error ? null : [], checks: steps };
await mkdir(dirname(reportFile), { recursive: true });
await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
await rm(candidate, { recursive: true, force: true });
console.log(JSON.stringify({ ...report, checks: steps.map(({ output, ...step }) => step), reportFile }, null, 2));
process.exitCode = report.passed ? 0 : 1;
