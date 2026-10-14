#!/usr/bin/env node
/** One-shot macOS scheduler: queue a user-authorized message on the same Codex thread. */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, unlink,rename } from "node:fs/promises";
import { dirname, join, resolve,basename } from "node:path";
import {randomUUID} from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const mode = argv[0];
const root = resolve(dirname(script), "..");
const configFile = resolve(option("config") ?? join(root, ".sakura", "continue.json"));
const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

async function store(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary=`${path}.${randomUUID()}.tmp`;
  try {await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });await rename(temporary,path);}
  finally {await unlink(temporary).catch(()=>{});}
}

function invoke(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? `${command} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function load() {
  return JSON.parse(await readFile(configFile, "utf8"));
}

if (mode === "--install") {
  if (process.platform !== "darwin") throw new Error("This scheduler uses macOS launchd.");
  const thread = option("thread");
  const at = option("at");
  if (!thread || !/^[a-f0-9-]{36}$/i.test(thread)) throw new Error("--thread requires the current Codex thread UUID.");
  if (!at || !/[+-]\d\d:\d\d$|Z$/.test(at)) throw new Error("--at requires an ISO timestamp with a timezone.");
  const target = new Date(at);
  if (!Number.isFinite(target.getTime()) || target.getTime() <= Date.now()) throw new Error("The scheduled time must be in the future.");
  const codex = option("codex") ?? invoke("/usr/bin/which", ["codex"]);
  const jobId=option("job-id");
  if(jobId && !/^[a-z0-9-]{1,48}$/.test(jobId))throw new Error("--job-id must contain 1–48 lowercase letters, digits or hyphens.");
  const label = `local.sakura.continue.${thread}${jobId?`.${jobId}`:""}`;
  const jobFile = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const stem=basename(configFile,".json");
  const statusFile = join(dirname(configFile), `${stem}-status.json`);
  const logFile = join(dirname(configFile), `${stem}.log`);
  const config = { thread, at: target.toISOString(), displayAt: at, cwd: root, codex, label, jobFile, statusFile, logFile, message: "继续" };
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(script)}</string><string>--run</string><string>--config</string><string>${xml(configFile)}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>StartCalendarInterval</key><dict><key>Month</key><integer>${target.getMonth() + 1}</integer><key>Day</key><integer>${target.getDate()}</integer><key>Hour</key><integer>${target.getHours()}</integer><key>Minute</key><integer>${target.getMinutes()}</integer></dict>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(`${dirname(codex)}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string></dict>
<key>StandardOutPath</key><string>${xml(logFile)}</string>
<key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict></plist>\n`;
  const service = `gui/${process.getuid()}/${label}`;
  if(argv.includes("--dry-run")){console.log(JSON.stringify({...config,service,installed:false,plist},null,2));process.exit(0);}
  spawnSync("/bin/launchctl", ["bootout", service], { encoding: "utf8" });
  await store(configFile, config);
  await store(statusFile, { status: "scheduled", thread, at: config.at, message: config.message });
  await mkdir(dirname(jobFile), { recursive: true });
  await writeFile(jobFile, plist, { mode: 0o600 });
  invoke("/usr/bin/plutil", ["-lint", jobFile]);
  invoke("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, jobFile]);
  console.log(JSON.stringify({ ...config, service }, null, 2));
} else if (mode === "--run") {
  const config = await load();
  let state;
  try { state = JSON.parse(await readFile(config.statusFile, "utf8")); } catch {}
  if (state?.status === "sent") {
    console.log("Already sent; no duplicate message.");
  } else if (state?.status === "cancelled") {
    console.log("Cancelled; no message sent.");
  } else if (Date.now() < Date.parse(config.at)) {
    console.log(`Waiting until ${config.displayAt}; no message sent.`);
  } else {
    const args = ["queue", "--thread", config.thread, "--message", config.message, "--cd", config.cwd];
    if (argv.includes("--dry-run")) {
      console.log(JSON.stringify({ command: config.codex, args }, null, 2));
    } else {
      try {
        const output = invoke(config.codex, args);
        await store(config.statusFile, { status: "sent", thread: config.thread, at: config.at, sentAt: new Date().toISOString(), message: config.message, output });
        console.log(`Queued '${config.message}' on ${config.thread}: ${output}`);
        await unlink(config.jobFile).catch(() => {});
        spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${config.label}`], { encoding: "utf8" });
      } catch (error) {
        await store(config.statusFile, { status: "failed", at: config.at, attemptedAt: new Date().toISOString(), error: error.message });
        throw error;
      }
    }
  }
} else if (mode === "--status") {
  const config = await load();
  console.log(await readFile(config.statusFile, "utf8"));
  const result = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${config.label}`], { encoding: "utf8" });
  console.log(result.status === 0 ? result.stdout : "LaunchAgent is not currently loaded.");
} else if (mode === "--cancel") {
  const config = await load();
  spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${config.label}`], { encoding: "utf8" });
  await unlink(config.jobFile).catch(() => {});
  await store(config.statusFile, { status: "cancelled", at: config.at, cancelledAt: new Date().toISOString() });
  console.log("Scheduled message cancelled.");
} else {
  console.log("node scripts/continue-thread.mjs --install --thread <uuid> --at <ISO time with timezone> [--job-id <name> --config <separate-file>] [--dry-run]\n  --status | --cancel | --run [--dry-run] [--config <file>]\nThe job sends exactly '继续' through codex queue on the existing thread. macOS must be running; sleep delays delivery until wake. A failed send is logged for manual retry.");
}
