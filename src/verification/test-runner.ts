import { spawn } from "node:child_process";
import type { CommandRunner } from "./verifier.ts";
import {mkdtemp,realpath,rm,open,writeFile,type FileHandle} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {canonicalProtectionPath,protectedSandboxSupported,linuxSeccompProgram,linuxSandboxArguments,type CommandProtection} from "./protected-command.ts";

/** Stop the process group and wait for exit; shell children cannot outlive artifact collection. */
export function createShellCommandRunner(protection?:CommandProtection): CommandRunner {
  return async (command, cwd, signal) => {
    signal?.throwIfAborted();
    if(protection&&!protectedSandboxSupported())throw new Error("Protected candidate replay requires OS isolation; this host has no configured backend");
    const canonicalProtection=protection?{readWriteDeny:await Promise.all(protection.readWriteDeny.map(canonicalProtectionPath)),writeDeny:await Promise.all(protection.writeDeny.map(canonicalProtectionPath))}:undefined;
    const temporary=protection?await mkdtemp(join(tmpdir(),"sakura-sandbox-")):undefined;
    const writable=protection?[await realpath(cwd),await realpath(temporary!)]:[];
    let filter:FileHandle|undefined,linuxArgs:string[]|undefined;
    try{if(protection&&process.platform==="linux"){
      linuxArgs=await linuxSandboxArguments(protection,writable[0],writable[1],command);
      const path=join(temporary!,"seccomp.bpf");await writeFile(path,linuxSeccompProgram());filter=await open(path,"r");
    }}catch(error){if(temporary)await rm(temporary,{recursive:true,force:true});throw error;}
    return new Promise((resolve, reject) => {
      const rules=canonicalProtection?`(version 1)(allow default)(deny mach-lookup)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null") ${writable.map(path=>`(subpath ${JSON.stringify(path)})`).join(" ")})${canonicalProtection.readWriteDeny.map(path=>`(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`).join("")}${canonicalProtection.writeDeny.map(path=>`(deny file-write* (subpath ${JSON.stringify(path)}))`).join("")}`:"";
      const environment=protection?{...process.env,TMPDIR:temporary,TMP:temporary,TEMP:temporary,npm_config_cache:join(temporary!,"npm-cache")}:process.env;
      const child = linuxArgs?spawn("/usr/bin/bwrap",linuxArgs,{cwd,env:environment,detached:true,stdio:["ignore","pipe","pipe",filter!.fd]}):protection?spawn("/usr/bin/sandbox-exec",["-p",rules,"/bin/sh","-c",command],{cwd,env:environment,detached:true,stdio:["ignore","pipe","pipe"]}):spawn(command, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (kind: NodeJS.Signals) => {
        try { if (process.platform === "win32") child.kill(kind); else if (child.pid) process.kill(-child.pid, kind); } catch {}
      };
      const cancel = () => { kill("SIGTERM"); escalation = setTimeout(() => kill("SIGKILL"), 1000); };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      child.stdout!.on("data", (chunk) => { stdout = (stdout + chunk).slice(-16 * 1024 * 1024); });
      child.stderr!.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16 * 1024 * 1024); });
      let cleaned:Promise<void>|undefined;
      const cleanup = () => cleaned??=(async()=>{ signal?.removeEventListener("abort", cancel); clearTimeout(escalation);await filter?.close();if(temporary)await rm(temporary,{recursive:true,force:true}); })();
      child.once("error", (error) => { void cleanup().then(()=>reject(error),reject); });
      child.once("close", (code) => {
        void cleanup().then(()=>{
        if (signal?.aborted) reject(new DOMException("Verification cancelled", "AbortError"));
        else resolve({ exitCode: code ?? 1, stdout, stderr });
        },reject);
      });
    });
  };
}

/** Shared policy for repository-defined checks; unattended approval never becomes permission. */
export function createVerificationCommandRunner(policy: import("../workspace/guard.ts").ExecutionPolicy, approve?: import("../workspace/guard.ts").Approval): CommandRunner {
  return async (command, cwd, signal) => {
    const { enforceAction } = await import("../workspace/guard.ts");
    const decision = await enforceAction({...policy, workspacePath:cwd}, {agentId:"verification",tool:"verification",kind:"exec",command}, approve);
    if (decision.type !== "allow") return {exitCode:1,stdout:"",stderr:decision.reason};
    return createShellCommandRunner()(command,cwd,signal);
  };
}
