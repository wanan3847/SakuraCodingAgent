import {registerSakuraCommand,sakuraCommandName} from '../src/ui/commands.ts';
/**
 * 插件 2/5 —— Multi-Agent Orchestrator（架构路线 §7 / §31.2）
 *
 * 薄壳：注册工具和命令，真正的接线全在 `src/run.ts`（CLI 用同一份，不写两遍）。
 * 展示的数字来自 trace/metrics，渲染层不自己算（架构路线 §26）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { enqueueRunInstruction, loadRunState, listRuns, loadPlan, newestRunMetrics, renderReport, runSakuraTaskOnce, type RunOutcome, type SakuraEvent } from "../src/index.ts";

/** 包内 skills/ 的绝对路径：路由要同时看包内的 5 个技能和项目自己的 skills/。 */
import { reduceProgress, renderProgress, type ProgressState } from "../src/ui/progress.ts";
import {plainTheme,brandHeader} from "../src/ui/brand.ts";
import {configFromHost,trackRun,cancelActiveRuns,drainActiveRuns} from '../src/runtime/host-context.ts';

const packageSkillsDir = new URL("../skills/", import.meta.url).pathname;

export default function sakuraOrchestrator(pi: ExtensionAPI): void {
  const active = new Map<string,AbortController>();
  let progress: ProgressState = { phase: "idle", tasks: {} };
  function show(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if(process.env.NO_COLOR!==undefined&&ctx.ui.theme.name!=="sakura-no-color")ctx.ui.setTheme(plainTheme(ctx.ui.theme));
    ctx.ui.setWidget("sakura-progress", (_tui, theme) => ({
      render(width) {
        const lines = renderProgress(progress, width);
        if(process.env.NO_COLOR!==undefined)return lines;
        const stateColor=progress.phase==='failed'?'error':progress.phase==='cancelled'||progress.phase==='unverified'?'warning':progress.phase==='applied'?'success':'accent';
        return lines.map((line,index)=>{
          if(index===1)return theme.fg('dim',line);
          const [,phase,...details]=line.split(' · ');
          const prefix='Sakura';
          return `${theme.fg('accent',prefix)}${theme.fg('dim',' · ')}${theme.fg(stateColor,phase??'')}${details.length?theme.fg('dim',` · ${details.join(' · ')}`):''}`;
        });
      }, invalidate() {},
    }));
  }
  pi.on("session_start", async (_event, ctx) => {
    progress = { phase: "idle", tasks: {} };show(ctx);
    if(ctx.hasUI){ctx.ui.setTitle("Sakura Coding Agent");ctx.ui.setHeader((_tui,theme)=>({render(width){const lines=brandHeader(width,process.env.SAKURA_NO_EMOJI!=="1");return process.env.NO_COLOR!==undefined?lines:lines.map(line=>theme.fg('accent',line));},invalidate(){}}));
    }
  });
  async function run(task: string, files: string[] | undefined, ctx: ExtensionContext, planPath?: string, signal?: AbortSignal, onEvent?: (event: SakuraEvent) => void, resumeRunId?:string): Promise<RunOutcome> {
    if (planPath) task = (await loadPlan(planPath)).rootTask;
    const tracked=trackRun(signal);
    const controller = tracked.controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort",abort,{once:true});
    if (signal?.aborted) abort();
    const key = `${ctx.cwd}:${Date.now()}`; active.set(key,controller);
    try { return await runSakuraTaskOnce({ task, files, cwd: ctx.cwd, planPath, resumeRunId, signal:controller.signal, skillDirs: [packageSkillsDir],
      rootPiSessionRef: ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId(),
      agentConfig: configFromHost(ctx),
      onEvent(event) { progress = reduceProgress(progress, event); show(ctx); onEvent?.(event); },
    }); } finally {active.delete(key); tracked.close();signal?.removeEventListener("abort",abort);}
  }

  const cancel = (ctx:ExtensionContext) => {const count=cancelActiveRuns(); if(ctx.hasUI) ctx.ui.notify(count ? "Sakura 正在取消并保存产物" : "没有运行中的 Sakura 任务","info");};
  pi.on('session_shutdown',async()=>{await drainActiveRuns();});
  registerSakuraCommand(pi,"sakura-cancel",{description:"Cancel running Sakura tasks and save artifacts",handler:async(_args,ctx)=>cancel(ctx)});
  pi.registerShortcut("ctrl+shift+x",{description:"Cancel Sakura tasks",handler:cancel});
  registerSakuraCommand(pi,"sakura-history",{description:"List Sakura runs and checkpoints",handler:async(_args,ctx)=>ctx.ui.notify(JSON.stringify(await listRuns(ctx.cwd),null,2),"info")});
  registerSakuraCommand(pi,"sakura-resume",{description:"Resume unfinished tasks: /sakura-resume <runId>",async handler(args,ctx){const id=args.trim();if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error("Invalid run id"); const state=await loadRunState(`${ctx.cwd}/.sakura/runs/${id}`);const result=await run(state.graph.rootTask,undefined,ctx,undefined,undefined,undefined,id);ctx.ui.notify(renderReport(result),result.completed?"info":"warning");}});
  registerSakuraCommand(pi,"sakura-instruct",{description:"/sakura-instruct <runId> <taskId> steer|follow-up|plan <text>",async handler(args,ctx){const [runId,target,mode,...text]=args.trim().split(/\s+/);if(!["steer","follow-up","plan"].includes(mode)) throw new Error("mode must be steer|follow-up|plan"); const queued=await enqueueRunInstruction(ctx.cwd,runId,{target,mode:mode as "steer"|"follow-up"|"plan",text:text.join(" ")});ctx.ui.notify(`queued: ${queued.id} → ${target}`,"info");}});

	pi.registerTool({
		name: "sakura_run",
		label: "Sakura Subagent",
		description:
			"Run a coding task end-to-end through Sakura: analyze, plan a DAG, run multiple agents in an isolated git worktree, verify with the project's own commands, and leave a trace plus diff for review.",
		promptSnippet: "Run a coding task through Sakura's multi-agent loop",
		promptGuidelines: [
			"Use sakura_run for multi-file bugfixes, features or refactors that need planning plus verification; use the built-in edit tools for single-file changes.",
			"sakura_run needs a reachable model provider; if it reports a connection or auth failure, fall back to the built-in tools instead of pretending the task was verified.",
			"sakura_run never merges its worktree; report the diff path and let the user decide.",
		],
		parameters: Type.Object({
			task: Type.Optional(Type.String({ description: "The coding task to complete; omit when planPath is provided" })),
			planPath: Type.Optional(Type.String({ description: "Execute a saved Sakura plan without creating a different plan" })),
			files: Type.Optional(Type.Array(Type.String(), { description: "Files the user already mentioned" })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "sakura: planning…" }], details: {} });
			if (!params.task && !params.planPath) throw new Error("task or planPath is required");
			const outcome = await run(params.task ?? "", params.files, ctx, params.planPath, _signal, (event) => {
				if (event.type === "run.phase") onUpdate?.({ content: [{ type: "text", text: `sakura: ${event.phase}` }], details: {} });
			});
			return { content: [{ type: "text", text: renderReport(outcome) }], details: { runId: outcome.runId, completed: outcome.completed, artifactPath: outcome.artifactPath }, isError: outcome.executionStatus === "failed" || outcome.checkStatus === "failed" };
		},
	});

	registerSakuraCommand(pi,"sakura-run", {
		description: "Automatically plan and coordinate subagents: /sakura-run <task>",
		async handler(args, ctx) {
			if (!args.trim()) {
				ctx.ui.notify(`usage: /${sakuraCommandName('sakura-run')} <task>`, "warning");
				return;
			}
			ctx.ui.notify("sakura: running…", "info");
			const planPath = args.trim().startsWith("--plan ") ? args.trim().slice(7).trim() : undefined;
			const outcome = await run(args.trim(), undefined, ctx, planPath);
			ctx.ui.notify(renderReport(outcome), outcome.completed ? "info" : "warning");
		},
	});

	registerSakuraCommand(pi,"sakura-status", {
		description: "Show the newest Sakura run metrics from .sakura/runs",
		async handler(_args, ctx) {
			const newest = await newestRunMetrics(ctx.cwd);
			if (!newest) {
				ctx.ui.notify("还没有 Sakura run（.sakura/runs 不存在）", "info");
				return;
			}
			ctx.ui.notify(
				`# Sakura ${newest.id}\ncheckpoint: ${newest.state?.phase??"unknown"}\n${newest.metrics?JSON.stringify(newest.metrics,null,2):"最终指标尚未生成；检查点表示最后保存的状态，不证明进程仍在运行。"}`,
				"info",
			);
		},
	});
}
