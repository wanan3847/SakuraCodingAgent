#!/usr/bin/env node
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const root = resolve(new URL("../",import.meta.url).pathname);
const temporary = await mkdtemp(join(tmpdir(),"sakura-install-"));
try {
  const packed = JSON.parse((await exec("npm",["pack","--json","--ignore-scripts","--pack-destination",temporary],{cwd:root})).stdout)[0];
  const artifact = join(temporary,packed.filename);
  // Pi 1.1.0 declares pi-codemode as ^1.1.0. A later minor release removed
  // MCP_TYPESCRIPT_PREAMBLE, so a fresh host install must pin the compatible
  // runtime dependency just as our checked-in lockfile does.
  await writeFile(join(temporary,"package.json"),JSON.stringify({private:true,type:"module",overrides:{"@earendil-works/pi-codemode":"1.1.0"}}));
  await exec("npm",["install","--ignore-scripts",artifact,"@earendil-works/pi-coding-agent@1.1.0","@earendil-works/pi-ai@1.1.0","@earendil-works/pi-tui@1.1.0","typebox@1.3.27"],{cwd:temporary,timeout:300000,maxBuffer:8*1024*1024});
  const project = join(temporary,"project");
  await mkdir(project);
  const env = {...process.env,PI_CODING_AGENT_DIR:join(temporary,"agent")};
  const cli = join(temporary,"node_modules","@earendil-works","pi-coding-agent","dist","cli.js");
  const installed = join(temporary,"node_modules","sakura-coding-agent");
  await exec(process.execPath,[cli,"install","-l",installed],{cwd:project,env,timeout:30000});
  await writeFile(join(temporary,"probe.mjs"),`
import assert from "node:assert/strict";
import {DefaultResourceLoader, SettingsManager} from "@earendil-works/pi-coding-agent";
const cwd=${JSON.stringify(project)};
const loader=new DefaultResourceLoader({cwd,agentDir:${JSON.stringify(env.PI_CODING_AGENT_DIR)},settingsManager:SettingsManager.create(cwd,${JSON.stringify(env.PI_CODING_AGENT_DIR)})});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors,[]);
assert.equal(loader.getExtensions().extensions.length,6);
assert.equal(loader.getThemes().themes.length,2);
assert.deepEqual(loader.getThemes().diagnostics,[]);
const packageSkills=loader.getSkills().skills.filter(s=>s.filePath.startsWith(${JSON.stringify(installed)}));
assert.equal(packageSkills.length,5);
assert.ok(loader.getPrompts().prompts.length>=1);
assert.ok(loader.getExtensions().extensions.some(e=>e.commands.has("sakura-cancel")));
console.log(JSON.stringify({extensions:6,themes:2,skills:packageSkills.length,otherAutoDiscoveredSkills:loader.getSkills().skills.length-packageSkills.length,prompts:loader.getPrompts().prompts.length}));
`);
  const resources = JSON.parse((await exec(process.execPath,[join(temporary,"probe.mjs")],{cwd:temporary,env,timeout:30000})).stdout);
  const releaseDir=join(root,".sakura","release");
  await mkdir(releaseDir,{recursive:true});
  await copyFile(artifact,join(releaseDir,packed.filename));
  const sha256=createHash("sha256").update(await readFile(artifact)).digest("hex");
  const report = {checkedAt:new Date().toISOString(),passed:true,pi:"1.1.0",piCodemode:"1.1.0",artifact:packed.filename,sha256,resources,nativeProjectInstall:true};
  await writeFile(join(root,".sakura","release","installed-package.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
} finally {await rm(temporary,{recursive:true,force:true});}
