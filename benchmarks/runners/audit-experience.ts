import assert from "node:assert/strict";
import {readFile,cp,mkdir,writeFile} from "node:fs/promises";
import {resolve,join} from "node:path";
import {createHash} from "node:crypto";
const root=resolve(new URL("../../",import.meta.url).pathname);
const reportPath=join(root,".sakura/benchmarks/experience-paired-v2.json");
const report=JSON.parse(await readFile(reportPath,"utf8"));
const seed=JSON.parse(await readFile(join(root,".sakura/benchmarks/experience-seed/experiences.json"),"utf8"));
assert.equal(report.complete,true);assert.equal(report.interrupted,false);assert.equal(report.trials.length,6);
const output=join(root,"benchmarks/reports/experience-2026-10-13");
await mkdir(output,{recursive:true});
const rows=[];
for(const trial of report.trials){
 const key=`${trial.taskId}-${trial.variant}-${trial.repeat}`,dir=join(root,".sakura/benchmarks/experience-paired-v2",key);
 const pack=JSON.parse(await readFile(join(dir,"sakura-run/context-pack.json"),"utf8"));
 const items=pack.selected.filter((item:{source:string})=>item.source.startsWith("experience-"));
 assert.deepEqual(items,trial.experienceSources);
 if(trial.variant==="sakura"){
  assert.equal(items.length,1);
  for(const item of items){assert.ok(item.text.includes(seed[0].runId));assert.ok(item.text.includes(seed[0].traceDir));assert.ok(item.text.includes(seed[0].successfulActions[0]));}
  assert.equal(trial.fixedVerification.passed,true);
 }else assert.equal(items.length,0);
 if(trial.status==="passed"){assert.equal(trial.verification.passed,true);assert.equal(trial.fixedVerification.passed,true);}
 rows.push({variant:trial.variant,repeat:trial.repeat,status:trial.status,durationMs:trial.durationMs,tokensIn:trial.tokensIn,tokensOut:trial.tokensOut,toolCalls:trial.toolCalls,experienceIds:items.length?[seed[0].id]:[]});
 await cp(dir,join(output,key),{recursive:true});
}
await cp(reportPath,join(output,"original-report.json"));
await cp(join(root,".sakura/benchmarks/experience-seed"),join(output,"seed"),{recursive:true});
await cp(resolve(root,seed[0].traceDir),join(output,"seed-source-run"),{recursive:true});
await writeFile(join(output,"audit.json"),JSON.stringify({at:new Date().toISOString(),reportSha256:createHash("sha256").update(await readFile(reportPath)).digest("hex"),rows,limitations:["Three repeats of one task cannot establish general benefit.","Original runner labels the 600-second timeout as cancelled; it remains a non-pass in statistics.","This historical runner predates indexing-read/replan-retry corrections; filesRead/retries are not used for benefit claims.","Original source fingerprint is preserved, but this historical run did not archive source files."]},null,2));
console.log(JSON.stringify({output,rows},null,2));
