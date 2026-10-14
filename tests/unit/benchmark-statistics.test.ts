import assert from "node:assert/strict";
import {test} from "node:test";
import {summarizeTrials} from "../../benchmarks/runners/statistics.ts";
test("benchmark statistics include failures and leave unmeasured tokens/cost unknown",()=>{
 const summary=summarizeTrials([{taskId:"t",variant:"pi",repeat:1,status:"passed",durationMs:10,tokensIn:20,metricsScope:"complete"},{taskId:"t",variant:"pi",repeat:2,status:"failed",durationMs:30,metricsScope:"complete"},{taskId:"t",variant:"pi-community",repeat:1,status:"setup_failed",durationMs:1,metricsScope:"root-only"}]);
 assert.equal(summary[0].successRate,0.5);assert.equal(summary[0].metrics.durationMs.mean,20);assert.equal(summary[0].metrics.tokensIn.mean,20);assert.equal(summary[0].metrics.tokensIn.measured,1);assert.equal(summary[0].metrics.cost.mean,null);assert.equal(summary[1].successRate,0);assert.equal(summary[1].comparable,false);
});
