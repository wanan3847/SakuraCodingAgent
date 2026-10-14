import assert from "node:assert/strict";
import {test} from "node:test";
import {readFile,mkdtemp,rm,readdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const exec=promisify(execFile);
test("all ten benchmark tasks clone a fixed bundled commit and exhibit the declared baseline",async(t)=>{
 const root=new URL("../../",import.meta.url).pathname;
 const dir=await mkdtemp(join(tmpdir(),"sakura-bench-check-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const tasks=(await readdir(join(root,"benchmarks","tasks"))).filter(path=>path.endsWith(".json"));assert.equal(tasks.length,10);
 const checked=[];
 for(const name of tasks) {
  const task=JSON.parse(await readFile(join(root,"benchmarks","tasks",name),"utf8"));assert.match(task.repo.commit,/^[a-f0-9]{40}$/);
  const cwd=join(dir,task.id);
  await exec("git",["clone","--quiet",join(root,"benchmarks","fixtures","token-refresh.bundle"),cwd]);await exec("git",["checkout","--quiet","--detach",task.repo.commit],{cwd});
  const current=(await exec("git",["rev-parse","HEAD"],{cwd})).stdout.trim();assert.equal(current,task.repo.commit);
  await exec(process.execPath,[join(root,"node_modules","typescript","bin","tsc"),"--noEmit"],{cwd});
  const passed=await exec(process.execPath,["tests/check.mjs"],{cwd}).then(()=>true,()=>false);
  assert.equal(passed,task.baselineExpected==="pass",task.id);
  checked.push(task.id);
 }
 assert.equal(checked.length,10);
});
