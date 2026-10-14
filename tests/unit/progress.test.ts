import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { reduceProgress, renderProgress, type ProgressState } from "../../src/ui/progress.ts";
import { brandHeader } from "../../src/ui/brand.ts";
import { verify } from "../../src/verification/verifier.ts";
import { createHeuristicPlanner } from "../../src/planning/planner.ts";
import { analyzeTask } from "../../src/planning/task-analyzer.ts";
test("every business phase remains distinct in plain text and recovery resets completed display",()=>{
 const phases={idle:"就绪",planning:"规划中",running:"编码中",verifying:"验证中",ready_to_apply:"待应用",unverified:"未验证",failed:"失败",cancelled:"已取消",applied:"已应用"} as const;
 for(const [phase,label] of Object.entries(phases)) {
  const state=reduceProgress({phase:"cancelled",tasks:{old:"succeeded"}},{type:"run.phase",runId:"恢复任务",phase:phase as ProgressState["phase"]});
  for(const width of [40,60,80,120])assert.ok(renderProgress(state,width)[0].includes(label));
  if(phase==="planning")assert.deepEqual(state.tasks,{});
 }
});

test("real task progress fits narrow columns with long Unicode task identifiers", () => {
  let state: ProgressState = { phase:"idle",tasks:{} };
  state=reduceProgress(state,{type:"run.phase",phase:"running",runId:"run-real-id"});
  state=reduceProgress(state,{type:"task.started",taskId:"中文长任务/路径/".repeat(10),agentId:"worker"});
  for (const width of [40,60,80,120]) {
      const lines=renderProgress(state,width);
      assert.ok(lines.every((line)=>visibleWidth(line)<=width));
      assert.ok(lines.every((line)=>!line.includes("\x1b")));
  }
  assert.equal(renderProgress(state,40).length,1);
  assert.ok(renderProgress(state,80).length<=2);
  assert.match(renderProgress({...state,phase:"cancelled"},40)[0],/已取消/);
  assert.match(renderProgress({...state,phase:"failed"},40)[0],/失败/);
});

test("brand header stays a single compact line and leaves commands to the native footer",()=>{
 for(const width of [40,60,80,120]){
  const lines=brandHeader(width);
  assert.equal(lines.length,1);
  assert.ok(visibleWidth(lines[0])<=width);
  assert.ok(lines[0].includes("Sakura Coding Agent"));
  assert.ok(lines[0].includes("🌸"));
  // Pi's native footer already carries the model, provider and context; no duplicate command hints.
  assert.doesNotMatch(lines[0],/\/sakura-(plan|run|history)/);
 }
});

test("no project checks is not_run, never a verified success", async () => {
  const result=await verify({cwd:"/tmp",commands:[],run:async()=>{throw new Error("must not run");},reviewDiff:async()=>[]});
  assert.equal(result.status,"not_run");
  assert.equal(result.passed,false);
});

test("read-only review generates no write roles and small edits use one agent", async () => {
  const planner=createHeuristicPlanner();
  for(const task of ["只读审查 auth bug", "review repository", "修改文档标点"]) {
    const analysis=analyzeTask({description:task,hintFiles:["README.md"]});
    const graph=await planner.plan({task,analysis});
    const roles=Object.values(graph.nodes).map((node)=>node.role);
    if(task.includes("标点")) assert.deepEqual(roles,["implementer"]);
    else assert.ok(roles.every((role)=>["explorer","reviewer"].includes(role)));
  }
});
