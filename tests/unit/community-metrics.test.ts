import assert from "node:assert/strict";
import {test} from "node:test";
import {communityMetrics} from "../../benchmarks/runners/community-metrics.ts";
test("community final receipts count each child once, successful reads and input context",async()=>{
 const receipt={runId:"r",results:[{index:0,model:"local/m",usage:{input:20,output:3},messages:[{role:"assistant",usage:{input:20,cacheRead:4},content:[{type:"toolCall",id:"read",name:"read",arguments:{path:"src/a.ts"}},{type:"toolCall",id:"fail",name:"read",arguments:{path:"missing"}}]},{role:"toolResult",toolCallId:"read",isError:false},{role:"toolResult",toolCallId:"fail",isError:true}]}]};
 const metrics=await communityMetrics([receipt,receipt],"local/m");
 assert.equal(metrics.agentCalls,1);assert.equal(metrics.toolCalls,2);assert.equal(metrics.tokensIn,20);assert.equal(metrics.contextTokens,24);assert.deepEqual(metrics.paths,["src/a.ts"]);assert.equal(metrics.complete,true);
});
test("community missing transcripts, fallback models and detached jobs are not comparable",async()=>{
 for(const child of [{model:"local/m"},{model:"other/m",messages:[]},{model:"local/m",messages:[],detached:true},{model:"local/m",messages:[],modelAttempts:[{model:"local/m"},{model:"local/m"}]}]) {
  const result=await communityMetrics([{runId:"r",results:[{index:0,usage:{input:0,output:0},...child}]}],"local/m");assert.equal(result.complete,false);
 }
});
