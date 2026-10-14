import assert from "node:assert/strict";
import {readFile,mkdir,mkdtemp,symlink,appendFile,rm,cp} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash} from "node:crypto";
import {readArtifact} from "../../src/workspace/apply-artifact.ts";
import {captureChanges} from "../../src/workspace/artifacts.ts";
import {verify} from "../../src/verification/verifier.ts";
import {createShellCommandRunner} from "../../src/verification/test-runner.ts";
import {prepareFixtureJudge} from "./fixture-judge.ts";
import {readOnlyVerdict} from "./verdict.ts";
import {atomicWrite} from "../../src/storage/atomic.ts";
const root=resolve(new URL("../../",import.meta.url).pathname),exec=promisify(execFile);
const cases=[
 {taskId:"auth-refresh",suite:"local-release-smoke-r5",review:"refresh 返回 next；保存的补丁只修改 auth-service.ts。"},
 {taskId:"dependency-module",suite:"local-release-smoke-r7",review:"新增 login-policy.ts，并将 canLogin 接入 loginLimit。存在非必要的反向 import，但没有顶层调用，当前 ESM 执行和冻结检查通过。"},
 {taskId:"expiry-boundary",suite:"local-release-smoke-r7",review:"expires 等于 now 时判定过期，边界使用 <=。"},
 {taskId:"public-user",suite:"local-release-smoke-r7",review:"返回新的 {name} 对象，不泄露 password。"},
 {taskId:"read-only-review",suite:"local-release-smoke-r6",review:"未修改仓库；最终回答准确指出 auth-service.ts:2 返回旧 token。"},
];
const output=join(root,"benchmarks","reports","release-2026-10-13"),results=[];
await mkdir(output,{recursive:true});
for(const item of cases) {
 const source=join(root,".sakura","benchmarks",item.suite,`${item.taskId}-sakura-1`),destination=join(output,item.taskId);
 const trial=JSON.parse(await readFile(join(source,"trial.json"),"utf8")),task=JSON.parse(await readFile(join(root,"benchmarks","tasks",`${item.taskId}.json`),"utf8"));
 assert.equal(trial.status,"passed");assert.equal(trial.execution,"succeeded");assert.equal(trial.baseCommit,task.repo.commit);
 const artifact=await readArtifact(join(source,"result.json")),answer=await readFile(join(source,"answer.txt"),"utf8");
 assert.equal(artifact.artifact.baseCommit,task.repo.commit);
 const workspace=await mkdtemp(join(tmpdir(),"sakura-release-audit-"));
 let judge:Awaited<ReturnType<typeof prepareFixtureJudge>>|undefined;
 try {
  await exec("git",["clone","--quiet",join(root,"benchmarks","fixtures","token-refresh.bundle"),workspace]);
  await exec("git",["checkout","--quiet","--detach",task.repo.commit],{cwd:workspace});
  await symlink(join(root,"node_modules"),join(workspace,"node_modules"),"dir");await appendFile(join(workspace,".git","info","exclude"),"\n/node_modules\n");
  judge=await prepareFixtureJudge(workspace,item.taskId,task.repo.commit);
  if(artifact.patch){await exec("git",["apply","--check","--binary",artifact.patchPath],{cwd:workspace});await exec("git",["apply","--binary",artifact.patchPath],{cwd:workspace});}
  const changes=await captureChanges(workspace,task.repo.commit);
  const verification=await verify({cwd:workspace,commands:task.verification.commands,run:createShellCommandRunner()});
  const frozen=await judge.run();assert.equal(verification.passed,true);assert.equal(frozen.passed,true);
  if(task.verification.readOnly)assert.equal(readOnlyVerdict({diff:changes.diff,answer,findingPattern:task.verification.findingPattern,locationPattern:task.verification.locationPattern}),true);
  else assert.ok(changes.changedFiles.length>0);
  await mkdir(destination,{recursive:true});
  await cp(join(source,"trial.json"),join(destination,"trial.json"));
  await cp(join(source,"answer.txt"),join(destination,"answer.txt"));
  await cp(join(source,"result.diff"),join(destination,"result.diff"));
  // The saved patch is standalone; the original manifest retains its original absolute path.
  await cp(join(source,"result.json"),join(destination,"original-manifest.json"));
  const patchSha256=createHash("sha256").update(artifact.patch).digest("hex");
  results.push({...item,baseCommit:task.repo.commit,model:"ollama/sakura-bench-qwen35-4b",readOnly:Boolean(task.verification.readOnly),changedFiles:changes.changedFiles,patchSha256,verification,frozen,reviewedBy:"Codex: source diff and replay audit",passed:true});
 }finally{await judge?.dispose();await rm(workspace,{recursive:true,force:true});}
}
const report={checkedAt:new Date().toISOString(),modelTrials:results.length,codingTrials:results.filter(row=>!row.readOnly).length,hasNewFile:results.some(row=>row.changedFiles.includes("src/auth/login-policy.ts")),passed:results.every(row=>row.passed),results};
await atomicWrite(join(output,"audit.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify({output,passed:report.passed,codingTrials:report.codingTrials,hasNewFile:report.hasNewFile},null,2));
