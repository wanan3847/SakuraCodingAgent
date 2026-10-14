import assert from "node:assert/strict";
import {test} from "node:test";
import {createTaskGraph,taskNode} from "../../src/planning/schemas.ts";
import {singleAgentPlan} from "../../benchmarks/runners/ablations.ts";
test("single-agent ablation preserves dynamically selected steps, acceptance and write scopes",()=>{
 const graph=createTaskGraph({id:"dynamic",rootTask:"add module",version:2,nodes:[taskNode({id:"source",title:"source",description:"write source",role:"implementer",writeScope:["src/"],dependencies:[],priority:1}),taskNode({id:"tests",title:"tests",description:"write regression",role:"tester",writeScope:["tests/"],dependencies:["source"],priority:2})]});
 const collapsed=singleAgentPlan(graph),worker=collapsed.nodes.worker;
 assert.equal(collapsed.version,2);assert.equal(Object.keys(collapsed.nodes).length,1);assert.match(worker.description,/write source/);assert.match(worker.description,/write regression/);assert.deepEqual(worker.writeScope,["src/","tests/"]);
 const review=singleAgentPlan(createTaskGraph({id:"review",rootTask:"read-only",nodes:[taskNode({id:"review",title:"review",description:"review",role:"reviewer",dependencies:[],priority:1})]}));
 assert.equal(review.nodes.worker.role,"reviewer");assert.equal(review.nodes.worker.writeScope,undefined);
 graph.nodes.tests.dependencies=["missing"];assert.throws(()=>singleAgentPlan(graph));
});
