import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { atomicWrite } from "../storage/atomic.ts";
import { loadRunState } from "./run-state.ts";
import type { TaskGraph } from "../planning/schemas.ts";
import type { SakuraEvent } from "../telemetry/events.ts";

export interface RunInstruction {
  id: string; target: string; mode: "steer" | "follow-up" | "plan"; text: string; createdAt: number;
  status: "queued" | "dispatching" | "dispatched" | "applied" | "rejected"; reason?: string; graphVersion?: number; deliveredAt?: number;
}
const safe = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
/** CLI/UI write one immutable identity per request; only the owning run delivers it. */
export async function enqueueRunInstruction(cwd: string, runId: string, input: Pick<RunInstruction,"target"|"mode"|"text">): Promise<RunInstruction> {
  if (!safe(runId) || !safe(input.target) || !["steer","follow-up","plan"].includes(input.mode) || !input.text.trim() || input.text.length > 16000) throw new Error("Invalid run instruction");
  const dir = join(cwd,".sakura","runs",runId);
  const state = await loadRunState(dir);
  if (state.endedAt || !["planning","running"].includes(state.phase ?? "")) throw new Error("Run is not accepting instructions");
  const task = state.graph.nodes[input.target];
  if (!task || !["pending","running"].includes(task.status)) throw new Error("Target task is not pending or running");
  if (input.mode === "plan" && task.status !== "pending") throw new Error("Plan changes require a pending target at the next scheduling boundary");
  const message: RunInstruction = {...input,id:randomUUID(),createdAt:Date.now(),status:"queued"};
  await atomicWrite(join(dir,"instructions",`${message.id}.json`), JSON.stringify(message,null,2));
  return message;
}

/** Business mailbox; live delivery calls the original Pi session methods directly. */
export function createRunInstructions(dir: string, emit: (event:SakuraEvent)=>void, signal?: AbortSignal) {
  const sessions = new Map<string,AgentSession>();
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  async function process(graph?: TaskGraph, finalReason?: string) {
    let names:string[];
    try {names = await readdir(join(dir,"instructions"));} catch(error) {if((error as NodeJS.ErrnoException).code === "ENOENT") return;throw error;}
    for (const name of names.sort()) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
      const path = join(dir,"instructions",name);
      const message = JSON.parse(await readFile(path,"utf8")) as RunInstruction;
      if (message.status !== "queued") continue;
      if (finalReason || signal?.aborted) {message.status="rejected";message.reason=finalReason ?? "Run cancelled";}
      else if (message.mode === "plan") {
        if (!graph) continue;
        const node = graph.nodes[message.target];
        if (node?.status !== "pending") {message.status="rejected";message.reason="Target is no longer pending";}
        else {node.description += `\n\n# User instruction ${message.id}\n${message.text}`;graph.version++;graph.updatedAt=Date.now();message.status="applied";message.graphVersion=graph.version;}
      } else {
        const session = sessions.get(message.target);
        if (!session) {
          if (graph && !["pending","running"].includes(graph.nodes[message.target]?.status)) {message.status="rejected";message.reason="Target session has ended";}
          else continue;
        } else {
          // A crash between marking and queueing is ambiguous; never replay into a different session.
          message.status="dispatching";
          await atomicWrite(path,JSON.stringify(message,null,2));
          try {
            const text = `User instruction ${message.id}:\n${message.text}`;
            if (message.mode === "steer") await session.steer(text); else await session.followUp(text);
            message.status="dispatched";message.deliveredAt=Date.now();
          } catch(error) {message.status="rejected";message.reason=String(error);}
        }
      }
      await atomicWrite(path,JSON.stringify(message,null,2));
      emit({type:"instruction.updated",id:message.id,target:message.target,status:message.status,graphVersion:message.graphVersion,reason:message.reason});
    }
  }
  function poll(graph?: TaskGraph, reason?:string) {tail=tail.then(()=>process(graph,reason));return tail;}
  const timer = setInterval(()=>{if(!closed) void poll().catch(()=>{});},100);
  timer.unref();
  return {
    attach(taskId:string, session:AgentSession) {sessions.set(taskId,session);return ()=>sessions.delete(taskId);},
    boundary: (graph:TaskGraph) => poll(graph),
    async close(reason="Run ended") {closed=true;clearInterval(timer);await poll(undefined,reason);sessions.clear();},
  };
}
