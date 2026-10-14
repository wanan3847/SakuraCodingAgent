import {registerSakuraCommand} from '../src/ui/commands.ts';
/**
 * 插件 4/5 —— Worktree + Sandbox（架构路线 §11 / §12 / §31.4）
 *
 * 两件事：
 *   1. `sakura_workspace` 工具：建/收 diff/查冲突/清理 git worktree，并可算出并行运行的冲突报告。
 *   2. `tool_call` 钩子：用 sandbox-policy 拦危险动作。Worktree 只隔离文件，不等于 Sandbox。
 *
 * 策略的 workspace 就是 Pi 自己的 cwd：workspace 外写 → deny，密钥文件 → deny，
 * git push / rm -rf / → 人工确认。容器级隔离不做（架构路线 §30）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join, resolve,relative } from "node:path";
import { createWorkspaceManager, detectConflict, loadConfig, saveArtifact, applyArtifact, readArtifact, type AgentSession } from "../src/index.ts";

import { actionForTool, enforceAction } from "../src/workspace/guard.ts";
import {guardedBash} from '../src/runtime/shell.ts';
import {undoCheckpoint} from '../src/workspace/apply-artifact.ts';
import {captureChanges,type WorkspaceChanges} from '../src/workspace/artifacts.ts';
import {saveCodeCheckpoint,resolveCheckpoint} from '../src/workspace/code-checkpoint.ts';
import {startHostBudget,currentHostBudget,finishHostBudget} from '../src/runtime/host-context.ts';
import {atomicWrite} from '../src/storage/atomic.ts';

const sessions = new Map<string, AgentSession>();

export default function sakuraWorkspace(pi: ExtensionAPI): void {
  let before:WorkspaceChanges|undefined;const edited=new Set<string>();
  pi.on('before_agent_start',async(_event,ctx)=>{
    startHostBudget(ctx.cwd,(await loadConfig(ctx.cwd)).runtime.budget);
    edited.clear();before=undefined;
    try{before=await captureChanges(ctx.cwd);}catch{if(ctx.hasUI)ctx.ui.setStatus('sakura-checkpoint','代码检查点需要 Git 仓库');}
  });
  pi.on('tool_result',async(event,ctx)=>{if(!event.isError&&['write','edit'].includes(event.toolName)&&typeof event.input.path==='string')edited.add(relative(ctx.cwd,resolve(ctx.cwd,event.input.path)));});
  pi.on('agent_settled',async(_event,ctx)=>{
    const budget=finishHostBudget(ctx.cwd);if(budget)await atomicWrite(join(ctx.cwd,'.sakura','last-budget.json'),JSON.stringify(budget,null,2));
    if(!before)return;
    try{const checkpoint=await saveCodeCheckpoint(ctx.cwd,before,[...edited]);if(checkpoint&&ctx.hasUI){ctx.ui.setStatus('sakura-checkpoint','代码检查点已保存 · /undo');}}
    catch(error){if(ctx.hasUI)ctx.ui.notify(`代码检查点未保存：${String(error)}`,'warning');}
    finally{before=undefined;edited.clear();}
  });
  pi.on('user_bash',async(_event,ctx)=>{
    const cfg=await loadConfig(ctx.cwd);
    return {operations:guardedBash({workspacePath:ctx.cwd,...cfg.policy},ctx.hasUI?async(action,decision)=>ctx.ui.confirm('Sakura 执行权限',`${decision.reason}\n${action.command??''}`):undefined)};
  });
	pi.registerTool({
		name: "sakura_workspace",
		label: "Sakura Workspace",
		description:
			"Manage isolated git worktrees for parallel agents: create, collect diff, detect overlapping changed files, and clean up.",
		promptSnippet: "Create and inspect Sakura git worktrees",
		promptGuidelines: [
			"Use sakura_workspace action=create when you need an isolated copy of the repo to modify in parallel with other work.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("diff"), Type.Literal("conflicts"), Type.Literal("cleanup")], {
				description: "Which workspace operation to run",
			}),
			taskId: Type.Optional(Type.String({ description: "Task id (create); defaults to a generated id" })),
		}),
		async execute(_toolCallId, params, _signal, _update, ctx) {
			const manager = createWorkspaceManager({ repoPath: ctx.cwd, rootDir: join(ctx.cwd, ".sakura", "worktrees") });

			try {
				switch (params.action) {
					case "create": {
						const taskId = params.taskId ?? `ws-${Date.now().toString(36)}`;
						const session = await manager.createWorkspace(taskId);
						sessions.set(taskId, session);
						return text(`worktree: ${session.worktreePath}\nbranch: ${session.branch}\nbase: ${session.baseCommit}`);
					}
					case "diff": {
						const target = params.taskId ? sessions.get(params.taskId) : [...sessions.values()].at(-1);
						if (!target) return text("没有已知 worktree；先 create，或用 taskId 指定。");
						const diff = await manager.collectDiff(target);
						return text(`changed: ${target.changedFiles.join(", ") || "none"}\n\n${diff.slice(0, 8000) || "(no diff)"}`);
					}
					case "conflicts": {
						const report = detectConflict([...sessions.values()]);
						return text(
							report.clean
								? "no overlapping changed files across tracked workspaces."
								: report.conflicts.map((conflict) => `${conflict.files.join(", ")} → ${conflict.sessions.join(" vs ")}`).join("\n"),
						);
					}
					case "cleanup": {
						const ids = params.taskId ? [params.taskId] : [...sessions.keys()];
						if (!ids.length) return text("没有已知 worktree。");
						for (const id of ids) {
							const session = sessions.get(id);
							if (!session) continue;
							await manager.collectDiff(session);
							if (!session.artifact) throw new Error("Workspace snapshot missing; refusing cleanup");
							await saveArtifact(join(ctx.cwd, ".sakura", "artifacts"), id, session.artifact);
							await manager.cleanup(session);
							sessions.delete(id);
						}
						return text(`cleaned: ${ids.join(", ")}`);
					}
					default:
						return text(`unsupported action ${String(params.action)}（params 类型是 any，所以这里必须显式兜底）`);
				}
			} catch (error) {
				return { content: [{ type: "text", text: `sakura_workspace failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: {} };
			}
		},
	});

	registerSakuraCommand(pi,"sakura-workspace", {
		description: "List Sakura worktrees tracked in this session",
		async handler(_args, ctx) {
			const listing = [...sessions.values()]
				.map((session) => `${session.taskId} → ${session.worktreePath} (${session.changedFiles.length} changed)`)
				.join("\n");
			ctx.ui.notify(listing || "本会话还没有创建 worktree", "info");
		},
	});

  registerSakuraCommand(pi,"sakura-diff", {
    description: "Preview a saved artifact: /sakura-diff <manifest.json>",
    async handler(args, ctx) {
      const saved = await readArtifact(resolve(ctx.cwd, args.trim()));
      ctx.ui.notify(saved.patch || "无改动", "info");
    },
  });
  registerSakuraCommand(pi,"sakura-apply", {
    description: "Apply an artifact to a clean matching base and verify: /sakura-apply <manifest.json>",
    async handler(args, ctx) {
      const [manifest,fileList]=args.trim().split(' --files ');
      const saved=await readArtifact(resolve(ctx.cwd,manifest));
      if(ctx.hasUI&&!await ctx.ui.confirm('接受变更',`${fileList??saved.artifact.changedFiles.join('\n')}\n将应用到当前干净仓库，并保存可撤销的代码检查点。`))return;
      const result = await applyArtifact(ctx.cwd, resolve(ctx.cwd,manifest), ctx.hasUI ? async(action,decision)=>ctx.ui.confirm("Sakura 执行权限", `${decision.reason}\n${action.command ?? ""}`) : undefined,fileList?.split(',').map(item=>item.trim()).filter(Boolean));
      ctx.ui.notify(JSON.stringify(result, null, 2), result.verification.passed ? "info" : "warning");
    },
  });
  registerSakuraCommand(pi,'sakura-undo',{description:'Undo the latest code checkpoint: /undo [checkpoint.json]',async handler(args,ctx){const checkpoint=await resolveCheckpoint(ctx.cwd,args);if(ctx.hasUI&&!await ctx.ui.confirm('撤销代码检查点','只有 HEAD、暂存区和工作区都符合检查点时才会撤销。'))return;ctx.ui.notify(JSON.stringify(await undoCheckpoint(ctx.cwd,checkpoint),null,2),'info');}});

  // Host and nested sessions share canonical path and approval rules.
  pi.on("tool_call", async (event, ctx) => {
    try{currentHostBudget(ctx.cwd)?.reserveTool();}catch(error){return {block:true,reason:String(error)};}
    const action = actionForTool(event.toolName, event.input, ctx.cwd, "pi");
    const network = ["fetch_content", "web_search", "mcpScript",'codemode','tool_search','list_mcp_resources','read_mcp_resource','list_mcp_resource_templates'].includes(event.toolName)||event.toolName.startsWith('mcp__');
    if (!action && !network) return;
    const cfg = await loadConfig(ctx.cwd);
    const decision = await enforceAction({ workspacePath:ctx.cwd, network:cfg.policy.network, gitPush:cfg.policy.gitPush,externalWrite:cfg.policy.externalWrite },
      action ?? {agentId:"pi",tool:event.toolName,kind:"exec",command:`MCP ${event.toolName}`},
      ctx.hasUI ? async(action,decision) => ctx.ui.confirm("Sakura 执行权限", `${action.tool}: ${decision.reason}\n${action.command ?? action.path ?? ""}`) : undefined);
    if (decision.type !== "allow") return {block:true,reason:`sakura policy denied ${event.toolName}: ${decision.reason}`};
  });
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: {} };
}
