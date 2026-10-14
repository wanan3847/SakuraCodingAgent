import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "../storage/atomic.ts";
import {readArtifact} from "./apply-artifact.ts";
import { captureChanges,saveArtifact,artifactPathspec } from "./artifacts.ts";
import { createWorkspaceManager } from "./workspace-manager.ts";
import type { AgentRunner,AgentRunInput,AgentRunResult } from "../orchestrator/agent-runner.ts";
import type { WorkspaceRef } from "../runtime/run-state.ts";
import { agentProfile } from "../orchestrator/agent-registry.ts";
const exec=promisify(execFile);

/** A commit of the integration working tree, built through a private index without moving HEAD. */
async function snapshotCommit(cwd:string) {
  const temporary=await mkdtemp(join(tmpdir(),"sakura-task-index-"));
  const env={...process.env,GIT_INDEX_FILE:join(temporary,"index"),GIT_AUTHOR_NAME:"Sakura",GIT_AUTHOR_EMAIL:"sakura@example.invalid",GIT_COMMITTER_NAME:"Sakura",GIT_COMMITTER_EMAIL:"sakura@example.invalid"};
  const git=async(...args:string[])=>(await exec("git",args,{cwd,env})).stdout.trim();
  try {
    const head=await git("rev-parse","HEAD");await git("read-tree",head);
    await git("add","-A","--",...await artifactPathspec(cwd,head));
    const tree=await git("write-tree");
    return git("commit-tree",tree,"-p",head,"-m","Sakura internal dependency snapshot");
  } finally {await rm(temporary,{recursive:true,force:true});}
}
export interface IntegrationRecord {createdAt:number;id:string;taskId:string;workspacePath:string;baseCommit:string;artifactPath?:string;status:"created"|"integrated"|"failed"|"conflict";error?:string;cleanupError?:string}
/** Writers get separate cwd; successful deltas enter the shared integration workspace before scheduling dependents. */
export function isolateTaskWorkspaces(options:{repoPath:string;integrationPath:string;runDir:string;runner:AgentRunner;cleanup:boolean;resumeArtifacts?:Record<string,string>;onWorkspace?:(ref:WorkspaceRef)=>Promise<void>}) : AgentRunner {
  let tail:Promise<void>=Promise.resolve();
  const restored=new Set<string>();
  function exclusive<T>(operation:()=>Promise<T>):Promise<T> {const pending=tail.then(operation);tail=pending.then(()=>undefined,()=>undefined);return pending;}
  return {async run(input:AgentRunInput):Promise<AgentRunResult> {
    if(!agentProfile(input.role).writes) return options.runner.run(input);
    input.signal?.throwIfAborted();
    const id=`${input.task.id}-${randomUUID().slice(0,8)}`;
    const baseRef=await exclusive(()=>snapshotCommit(options.integrationPath));
    const manager=createWorkspaceManager({repoPath:options.repoPath,rootDir:join(options.repoPath,".sakura","worktrees"),baseRef});
    const session=await manager.createWorkspace(id);
    const record:IntegrationRecord={createdAt:Date.now(),id,taskId:input.task.id,workspacePath:session.worktreePath,baseCommit:session.baseCommit,status:"created"};
    const recordPath=join(options.runDir,"integrations",`${id}.json`);
    let saved=false,integrated=false;
    try {
      await atomicWrite(recordPath,JSON.stringify(record,null,2));
      await options.onWorkspace?.({taskId:id,path:session.worktreePath,baseCommit:session.baseCommit,branch:session.branch});
      if(options.resumeArtifacts?.[input.task.id] && !restored.has(input.task.id)) {
        const recovery=await readArtifact(options.resumeArtifacts[input.task.id]);
        if(recovery.patch){await exec("git",["apply","--check","--binary",recovery.patchPath],{cwd:session.worktreePath});await exec("git",["apply","--binary",recovery.patchPath],{cwd:session.worktreePath});}
        restored.add(input.task.id);
      }
      const result=await options.runner.run({...input,workspacePath:session.worktreePath,baseCommit:session.baseCommit});
      const changes=await captureChanges(session.worktreePath,session.baseCommit);
      record.artifactPath=await saveArtifact(join(options.runDir,"task-artifacts"),id,changes);saved=true;
      if(result.status!=="success" || input.signal?.aborted) {
        record.status="failed";record.error=result.summary;
        return {...result,status:input.signal?.aborted?"failure":result.status,evidence:[...result.evidence,`partial task artifact: ${record.artifactPath}; recovery workspace: ${session.worktreePath}`]};
      }
      await exclusive(async()=>{
        input.signal?.throwIfAborted();
        if(changes.diff) {
          const patchPath=join(options.runDir,"task-artifacts",`${id}.diff`);
          await exec("git",["apply","--check","--binary",patchPath],{cwd:options.integrationPath});
          await exec("git",["apply","--binary",patchPath],{cwd:options.integrationPath});
        }
        record.status="integrated";
        await atomicWrite(recordPath,JSON.stringify(record,null,2));
        integrated=true;
      });
      return {...result,changedFiles:changes.changedFiles,diff:changes.diff,evidence:[...result.evidence,`integrated task artifact: ${record.artifactPath}`]};
    } catch(error) {
      const integrationFailed=saved;
      if(!saved) try {record.artifactPath=await saveArtifact(join(options.runDir,"task-artifacts"),id,await captureChanges(session.worktreePath,session.baseCommit));saved=true;} catch(saveError){record.cleanupError=`Artifact persistence failed: ${String(saveError)}`;}
      record.status=integrationFailed?"conflict":"failed";record.error=String(error);
      return {status:"needs_replan",summary:`${integrationFailed?"Integration conflict":"Task workspace failed"}: ${record.error}`,changedFiles:[],evidence:[`integration record: ${recordPath}`,`preserved workspace: ${session.worktreePath}`,`artifact: ${record.artifactPath ?? "not saved"}`,"Recovery: inspect preserved edits; resume the run to execute unfinished nodes on the integrated dependency snapshot."]};
    } finally {
      // Failed/cancelled/conflicting workspaces remain available, including partial changes not integrated.
      if(saved && integrated && options.cleanup) await manager.cleanup(session).catch(error=>{record.cleanupError=String(error);});
      await atomicWrite(recordPath,JSON.stringify(record,null,2));
    }
  }};
}
