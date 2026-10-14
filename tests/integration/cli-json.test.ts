import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createRunTrace} from "../../src/telemetry/trace.ts";
test("CLI status JSON is clean before any run and matches persisted measurements after a run",async(t)=>{
 const cwd=await mkdtemp(join(tmpdir(),"sakura-cli-json-"));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const cli=new URL("../../src/cli/dev.ts",import.meta.url).pathname;
 const status=async()=>{const result=await promisify(execFile)(process.execPath,[cli,"status","--json"],{cwd,env:{...process.env,NO_COLOR:"1",SAKURA_NO_EMOJI:"1"}});assert.doesNotMatch(result.stdout,/\x1b|🌸/);return JSON.parse(result.stdout);};
 assert.deepEqual(await status(),{runId:null,checkpoint:null,metrics:null});
 const trace=await createRunTrace("json-evidence",cwd);
 trace.emit({type:"task.started",taskId:"真实任务",agentId:"worker"});trace.emit({type:"tool.called",agentId:"worker",tool:"read"});trace.emit({type:"task.usage",taskId:"真实任务",agentId:"worker",tokensIn:42,tokensOut:7});
 const measured=await trace.finish();assert.deepEqual((await status()).metrics,measured);
});
