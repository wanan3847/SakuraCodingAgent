import assert from "node:assert/strict";
import { test } from "node:test";
import { createReplanner } from "../../src/planning/replanner.ts";
import { createTaskGraph, taskNode } from "../../src/planning/schemas.ts";
import { runSakuraTask } from "../../src/orchestrator/orchestrator.ts";
const graph=()=>createTaskGraph({id:"repair",rootTask:"fix behavior",nodes:[taskNode({id:"explore",role:"explorer",title:"explore",description:"explore",priority:1,dependencies:[]}),taskNode({id:"fix",role:"implementer",title:"fix",description:"fix",priority:1,dependencies:["explore"],writeScope:["source.ts"],maxRetries:0})]});

test("repair preserves completed nodes and carries verification evidence into the next version",async()=>{
 const seen:string[]=[];let checks=0;
 const result=await runSakuraTask({task:"fix behavior"},{planner:{plan:async()=>graph()},replanner:createReplanner(),maxConcurrency:1,maxReplans:2,
 runTask:async(task)=>{seen.push(task.id);if(checks)assert.match(task.description,/failed assertion/);return{status:"success",summary:"done",changedFiles:[],evidence:[]};},
 verify:async()=>{checks++;return{passed:checks>1,status:checks>1?"passed":"failed",steps:[],reviewedDiff:false,failures:checks===1?[{command:"test",exitCode:1,reason:"failed assertion"}]:[]};}
 });
 assert.equal(result.completed,true);assert.deepEqual(seen,["explore","fix","fix"]);assert.equal(result.graph.version,2);assert.equal(result.scheduler.replans,1);
});

test("persistent repair failures terminate at the global replan budget",async()=>{
 let calls=0;
 const result=await runSakuraTask({task:"fix behavior"},{planner:{plan:async()=>graph()},replanner:createReplanner(),maxConcurrency:1,maxReplans:2,runTask:async()=>{calls++;return{status:"success",summary:"done",changedFiles:[],evidence:[]};},verify:async()=>({passed:false,status:"failed",steps:[],reviewedDiff:false,failures:[{command:"test",exitCode:1,reason:"assertion broken"}]})});
 assert.equal(result.completed,false);assert.equal(result.scheduler.replans,2);assert.equal(calls,4);
});

test("permission or credential failures never get an automatic repair retry",async()=>{
 const g=graph();g.nodes.fix.status="failed";
 assert.equal(await createReplanner().replan({graph:g,failed:[g.nodes.fix],evidence:"Approval required"}),undefined);
});
