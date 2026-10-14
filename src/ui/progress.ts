import { truncateToWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { RunPhase, SakuraEvent } from "../telemetry/events.ts";

const labels: Record<RunPhase, string> = { idle: "就绪", planning: "规划中", running: "编码中", verifying: "验证中", ready_to_apply: "待应用", unverified: "未验证", failed: "失败", cancelled: "已取消", applied: "已应用" };
export interface ProgressState { phase: RunPhase; runId?: string; tasks: Record<string, string>;lastAction?:string }
export function reduceProgress(state: ProgressState, event: SakuraEvent): ProgressState {
  if (event.type === "run.phase") return { ...state, phase: event.phase, runId: event.runId, lastAction: event.phase === "planning" ? undefined : state.lastAction, tasks: event.phase === "planning" ? {} : state.tasks };
  if (event.type === "task.started") return { ...state, tasks: { ...state.tasks, [event.taskId]: "running" } };
  if (event.type === "task.created") return {...state,tasks:{...state.tasks,[event.taskId]:"pending"}};
  if (event.type === "tool.called") return {...state,lastAction:`${event.tool}${event.path?` · ${event.path}`:''}`};
  if (event.type === "task.finished") return { ...state, tasks: { ...state.tasks, [event.taskId]: event.status } };
  return state;
}
export function renderProgress(state: ProgressState, width: number): string[] {
  const values = Object.values(state.tasks);
  const active = Object.entries(state.tasks).filter(([, status]) => status === "running").map(([id]) => id);
  const finished = values.filter((status) => status === "succeeded").length;
  const failed = values.filter((status) => status === "failed").length;
  const lines = [`Sakura · ${labels[state.phase]}${values.length ? ` · 完成 ${finished}/${values.length} · 执行 ${active.length} · 失败 ${failed}` : ""}`];
  const detail = state.lastAction ?? active[0];
  if (width >= 80 && detail) lines.push(`当前 · ${detail}`);
  return lines.map((line) => stripTerminalSequences(truncateToWidth(stripTerminalSequences(line), Math.max(1, width))));
}
