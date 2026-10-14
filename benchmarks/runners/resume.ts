import {createHash} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {join} from "node:path";
import type {TrialResult} from "./statistics.ts";
export const trialKey=(trial:{taskId:string;variant:string;repeat:number})=>`${trial.taskId}/${trial.variant}/${trial.repeat}`;
export async function sourceFingerprint(root:string) {
 const hash=createHash("sha256");
 async function visit(path:string) {
  for(const entry of (await readdir(join(root,path),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
   const file=join(path,entry.name);
   if(entry.isDirectory())await visit(file);
   else if(entry.isFile()){hash.update(file);hash.update(await readFile(join(root,file)));}
  }
 }
 for(const path of ["src","extensions","benchmarks/runners","benchmarks/tasks","benchmarks/fixtures"])await visit(path);
 hash.update(await readFile(join(root,"package-lock.json")));
 hash.update(await readFile(join(root,"package.json")));
 return hash.digest("hex");
}
export function validateResume(previous:{metadata:{contractSha256?:string};trials:TrialResult[]}, contractSha256:string, matrix:Array<{taskId:string;variant:string;repeat:number;baseCommit:string;timeoutMs:number}>) {
 if(previous.metadata.contractSha256!==contractSha256)throw new Error("Cannot resume: model, source, matrix or experience seed changed; start a new report");
 const seen=new Set<string>(),allowed=new Map(matrix.map(row=>[trialKey(row),row]));
 for(const row of previous.trials) {
  const key=trialKey(row),expected=allowed.get(key);
  if(seen.has(key)||!expected||row.baseCommit!==expected.baseCommit||row.timeoutMs!==expected.timeoutMs||!["passed","failed","cancelled","setup_failed"].includes(row.status))throw new Error(`Invalid resumed trial: ${key}`);
  seen.add(key);
 }
 return seen;
}
