import { execFile } from "node:child_process";
import { readFile,mkdir,lstat } from "node:fs/promises";
import {withFileLock} from "../storage/lock.ts";
import {selectPatch} from "./patch-selection.ts";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { loadConfig } from "../config.ts";
import { enforceAction, type Approval } from "./guard.ts";
import { atomicWrite } from "../storage/atomic.ts";
import { captureChanges, type WorkspaceArtifact } from "./artifacts.ts";
import { detectVerificationPlan, toCommandSequence } from "../verification/command-detector.ts";
import { verify, type VerificationResult } from "../verification/verifier.ts";
import { createShellCommandRunner } from "../verification/test-runner.ts";
const exec = promisify(execFile);
const digest = (content: string) => createHash("sha256").update(content).digest("hex");

export async function readArtifact(path: string): Promise<{ artifact: WorkspaceArtifact; patch: string; patchPath: string; hash: string }> {
  const artifact = JSON.parse(await readFile(path, "utf8")) as WorkspaceArtifact;
  if (artifact.version !== 1 || !/^[a-f0-9]{40,64}$/.test(artifact.baseCommit) || typeof artifact.diffFile !== "string" || basename(artifact.diffFile) !== artifact.diffFile || !artifact.diffFile.endsWith(".diff")) throw new Error("Invalid artifact manifest");
  const patchPath = resolve(dirname(path), artifact.diffFile);
  const patch = await readFile(patchPath, "utf8");
  const hash = digest(patch);
  if (artifact.patchSha256 && artifact.patchSha256 !== hash) throw new Error("Artifact patch checksum mismatch");
  return { artifact, patch, patchPath, hash };
}
export interface ApplyResult {
  status: "applied";
  duplicate: boolean;
  artifactPath: string;
  verification: VerificationResult;
  receiptPath: string;
  checkpointPath?:string;
  selectedFiles?:string[];
}
/** Explicit action only. git apply checks all hunks before changing files; no automatic merge/push. */
export async function applyArtifact(cwd:string,path:string,approve?:Approval,files?:string[]):Promise<ApplyResult>{
 await mkdir(join(cwd,'.sakura'),{recursive:true});
 return withFileLock(join(cwd,'.sakura','apply.lock'),()=>applyUnlocked(cwd,path,approve,files));
}
async function applyUnlocked(cwd:string,path:string,approve?:Approval,files?:string[]):Promise<ApplyResult>{
  const original=await readArtifact(path);
  const artifact=original.artifact;
  const selected=await selectPatch(cwd,artifact.baseCommit,original.patch,files);
  const patch=selected.patch,hash=digest(patch);
  const git = async (...args: string[]) => (await exec("git", args, { cwd })).stdout;
  const head = (await git("rev-parse", "HEAD")).trim();
  if (head !== artifact.baseCommit) throw new Error(`Artifact base mismatch: expected ${artifact.baseCommit}, found ${head}`);
  const checkpointPath=join(cwd,'.sakura','checkpoints',`${hash}.json`);
  const receiptPath = join(cwd, ".sakura", "applied", `${hash}.json`);
  let receipt: ApplyResult | undefined;
  try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if(receipt?.checkpointPath===checkpointPath){const checkpoint=JSON.parse(await readFile(checkpointPath,'utf8'));if(checkpoint.status==='undone')receipt=undefined;}
  if (receipt) {
    const snapshot = await captureChanges(cwd, artifact.baseCommit);
    if (digest(snapshot.diff) !== ((receipt as ApplyResult&{workspaceSha256?:string}).workspaceSha256??original.hash)) throw new Error("Artifact was applied previously, but the target has since changed; refusing repeat application.");
    return { ...receipt, duplicate: true };
  }
  // Ignore Sakura's own generated metadata, including when the repository has no .gitignore.
  const snapshot = await captureChanges(cwd, artifact.baseCommit);
  if (snapshot.diff || (await git("diff", "--cached", "--name-only")).trim()) throw new Error("Target repository has uncommitted changes; apply to a clean base.");
  const patchFile=join(cwd,'.sakura','checkpoints',`${hash}.diff`);
  // Write recovery intent before changing the worktree. A crash leaves a reviewable patch.
  await atomicWrite(patchFile,patch);
  await atomicWrite(checkpointPath,JSON.stringify({version:1,status:'applying',baseCommit:artifact.baseCommit,patchFile,patchSha256:hash,createdAt:Date.now()},null,2));
  if (patch) {
    await git("apply", "--check", "--binary", patchFile);
    await git("apply", "--binary", patchFile);
  }
  const appliedSnapshot=await captureChanges(cwd,artifact.baseCommit);
  await atomicWrite(patchFile,appliedSnapshot.diff);
  await atomicWrite(checkpointPath,JSON.stringify({version:1,status:'applied',baseCommit:artifact.baseCommit,patchFile,patchSha256:digest(appliedSnapshot.diff),createdAt:Date.now()},null,2));
  const commands = (await loadConfig(cwd)).verification.commands ?? toCommandSequence(await detectVerificationPlan(cwd));
  let verification: VerificationResult;
  try { verification = await verify({ cwd, commands, run: async (command, cwd, signal) => {
    const cfg = await loadConfig(cwd);
    const decision = await enforceAction({ workspacePath:cwd, network:cfg.policy.network, gitPush:cfg.policy.gitPush,externalWrite:cfg.policy.externalWrite },{agentId:"verification",tool:"verification",kind:"exec",command},approve);
    if(decision.type!=="allow") return {exitCode:1,stdout:"",stderr:decision.reason};
    return createShellCommandRunner()(command,cwd,signal);
  } }); }
  catch (error) { verification = { passed: false, status: "failed", steps: [], reviewedDiff: false, failures: [{ command: "verification", exitCode: 1, reason: String(error) }] }; }
  const result: ApplyResult = { status: "applied", duplicate: false, artifactPath: resolve(path), verification, receiptPath,checkpointPath,selectedFiles:selected.files };
  await atomicWrite(receiptPath, JSON.stringify({...result,workspaceSha256:digest(appliedSnapshot.diff)}, null, 2) + "\n");
  return result;
}

/** Refuse any intervening code edits or staging. This never rewinds conversation history. */
export async function undoCheckpoint(cwd:string,path:string):Promise<{status:'undone';checkpointPath:string}>{
 await mkdir(join(cwd,'.sakura'),{recursive:true});
 return withFileLock(join(cwd,'.sakura','apply.lock'),async()=>{
  if(dirname(resolve(path))!==resolve(cwd,'.sakura','checkpoints')||(await lstat(path)).isSymbolicLink())throw new Error('Select a checkpoint in this project');
  const entry=JSON.parse(await readFile(path,'utf8'));
  if(entry.version!==1||!['applying','applied','undone'].includes(entry.status)||!/^[a-f0-9]{40,64}$/.test(entry.baseCommit)||typeof entry.patchFile!=='string'||typeof entry.patchSha256!=='string')throw new Error('Invalid code checkpoint');
  if(resolve(entry.patchFile)!==resolve(cwd,'.sakura','checkpoints',basename(entry.patchFile))||!entry.patchFile.endsWith('.diff'))throw new Error('Checkpoint patch must be inside this project');
  if((await lstat(entry.patchFile)).isSymbolicLink())throw new Error('Checkpoint patch must not be a symlink');
  const patch=await readFile(entry.patchFile,'utf8');
  if(digest(patch)!==entry.patchSha256)throw new Error('Checkpoint checksum mismatch');
  const git=async(...args:string[])=>(await exec('git',args,{cwd})).stdout;
  const staged=await git('diff','--cached','--binary');
  if((await git('rev-parse','HEAD')).trim()!==entry.baseCommit||(entry.stagedSha256?digest(staged)!==entry.stagedSha256:staged.trim()))throw new Error('Repository HEAD or staging changed; refusing undo');
  const snapshot=await captureChanges(cwd,entry.baseCommit);
  if(entry.status==='undone'){if(entry.undoneSha256?digest(snapshot.diff)!==entry.undoneSha256:!!snapshot.diff)throw new Error('Checkpoint already undone, repository changed');return {status:'undone',checkpointPath:resolve(path)};}
  // An interrupted application may still be entirely untouched; mark it safely undone.
  if(entry.status==='applying'&&!snapshot.diff){await atomicWrite(path,JSON.stringify({...entry,status:'undone'},null,2));return {status:'undone',checkpointPath:resolve(path)};}
  if(digest(snapshot.diff)!==(entry.workspaceSha256??entry.patchSha256))throw new Error('Code changed since checkpoint; refusing to overwrite user edits. Review the saved patch manually.');
  // Recheck path policy from the actual patch rather than trusting metadata.
  await selectPatch(cwd,entry.beforeTree??entry.baseCommit,patch);
  if(patch){await git('apply','--reverse','--check','--binary',entry.patchFile);await git('apply','--reverse','--binary',entry.patchFile);}
  await atomicWrite(path,JSON.stringify({...entry,status:'undone',undoneAt:Date.now(),undoneSha256:digest((await captureChanges(cwd,entry.baseCommit)).diff)},null,2));
  return {status:'undone',checkpointPath:resolve(path)};
 });
}
