import {registerSakuraCommand} from '../src/ui/commands.ts';
/**
 * 插件 6 —— 并行委托（薄壳）。
 *
 * 逻辑全在 `src/orchestrator/delegate.ts`；这里只做：把工具参数变成 DelegateTaskSpec、
 * 把结果渲染成人能看懂的文本。CLI 用的是同一份实现。
 *
 * 为什么需要它（而不是 `sakura_run`）：`sakura_run` 走 Planner→TaskGraph→调度器，
 * 适合"一个有依赖关系的任务"。当它已经拆出几个**互相独立**的子任务时，直接并行委托更省事，
 * 也不需要每次都付出一次规划。
 *
 * 不自动合并：每个写任务在自己的 worktree 里干，跑完只留 diff 到 trace 目录。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {configFromHost,trackRun} from "../src/runtime/host-context.ts";
import { Type } from "typebox";
import { delegateTasks, loadConfig, renderDelegation, type DelegateTaskSpec } from "../src/index.ts";

export default function sakuraDelegate(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sakura_delegate",
		label: "Sakura Delegate",
		description:
			"Run several INDEPENDENT subtasks in parallel, each in its own isolated git worktree, then report results and a changed-file conflict report. Use when the subtasks do not depend on each other.",
		promptSnippet: "Run independent subtasks in parallel in isolated worktrees",
		promptGuidelines: [
			"Use sakura_delegate only for subtasks that do NOT depend on each other; if one subtask needs another's output, use sakura_plan + sakura_run instead.",
			"sakura_delegate never merges the worktrees; report each task's diff path and let the user decide.",
			"Give every writing subtask a writeScope, otherwise two agents may edit the same file and the conflict report will flag it.",
		],
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					id: Type.String({ description: "Short unique id, e.g. fix-auth. Used for the worktree and diff file name." }),
					description: Type.String({ description: "What this agent must accomplish, written as an outcome" }),
					role: Type.Union(
						[
							Type.Literal("explorer"),
							Type.Literal("architect"),
							Type.Literal("implementer"),
							Type.Literal("tester"),
							Type.Literal("reviewer"),
							Type.Literal("researcher"),
						],
						{ description: "Which role runs it: explorer/reviewer are read-only (no worktree), implementer/tester write" },
					),
					writeScope: Type.Optional(
						Type.Array(Type.String(), { description: "Path prefixes this agent may write. Strongly recommended for implementer/tester" }),
					),
					context: Type.Optional(Type.String({ description: "Extra context: relevant files, constraints, past failures" })),
				}),
				{ description: "Independent subtasks to run in parallel" },
			),
			keepWorktrees: Type.Optional(
				Type.Boolean({ description: "Keep each worktree on disk for manual review instead of cleaning up (default false)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const cfg = await loadConfig(ctx.cwd);
			onUpdate?.({ content: [{ type: "text", text: `sakura: delegating ${params.tasks.length} task(s)…` }], details: {} });

			const tracked=trackRun(_signal);
			let outcome;try{outcome = await delegateTasks({
				cwd: ctx.cwd,signal:tracked.controller.signal,
				tasks: params.tasks as DelegateTaskSpec[],
				config: { localOnly: cfg.runtime.localOnly,...configFromHost(ctx) },
				maxConcurrency: cfg.runtime.maxConcurrency,
				timeoutMs: cfg.runtime.taskTimeoutMs,
				keepWorktrees: params.keepWorktrees ?? false,
				onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }),
			});}finally{tracked.close();}

			// keepWorktrees 为 true 时 delegateTasks 不清理，留给用户 review；这里不主动清，
			// 否则 renderDelegation 报出来的 worktree 路径刚给出就已经不存在了。
			return { content: [{ type: "text", text: renderDelegation(outcome) }], details: {} };
		},
	});

	registerSakuraCommand(pi,"sakura-delegate", {
		description: "Delegate independent subtasks in parallel: /sakura-delegate <task> ; <task> ; <task>",
		async handler(args, ctx) {
			const descriptions = args
				.split(";")
				.map((part) => part.trim())
				.filter(Boolean);
			if (!descriptions.length) {
				ctx.ui.notify("usage: /sakura-delegate <task1> ; <task2>", "warning");
				return;
			}

			const cfg = await loadConfig(ctx.cwd);
			ctx.ui.notify(`sakura: delegating ${descriptions.length} task(s)…`, "info");
			const tracked=trackRun(ctx.signal);
			let outcome;try{outcome = await delegateTasks({
				cwd: ctx.cwd,signal:tracked.controller.signal,
				tasks: descriptions.map((description, index) => ({
					id: `task-${index + 1}`,
					description,
					// 命令行给不出 writeScope，写角色一律当 implementer；要精确控制就用工具调用
					role: "implementer" as const,
				})),
				config: { localOnly: cfg.runtime.localOnly,...configFromHost(ctx) },
				maxConcurrency: cfg.runtime.maxConcurrency,
				timeoutMs: cfg.runtime.taskTimeoutMs,
				keepWorktrees: false,
			});}finally{tracked.close();}
			ctx.ui.notify(renderDelegation(outcome), "info");
		},
	});
}
