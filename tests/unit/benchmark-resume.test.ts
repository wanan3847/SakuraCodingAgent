import assert from "node:assert/strict";
import {test} from "node:test";
import {validateResume} from "../../benchmarks/runners/resume.ts";
import type {TrialResult} from "../../benchmarks/runners/statistics.ts";
test("benchmark resume keeps terminal failures and rejects changed or duplicated evidence",()=>{
 const matrix=[{taskId:"t",variant:"pi",repeat:1,baseCommit:"fixed",timeoutMs:10}];
 const row:TrialResult={...matrix[0],status:"failed",durationMs:10,metricsScope:"complete"};
 const previous={metadata:{contractSha256:"same"},trials:[row]};
 assert.deepEqual([...validateResume(previous,"same",matrix)],["t/pi/1"]);
 assert.throws(()=>validateResume(previous,"different",matrix),/Cannot resume/);
 assert.throws(()=>validateResume({...previous,trials:[row,row]},"same",matrix),/Invalid resumed trial/);
 assert.throws(()=>validateResume({...previous,trials:[{...row,baseCommit:"changed"}]},"same",matrix),/Invalid resumed trial/);
});
