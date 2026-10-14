/**
 * 把 Pi AgentSession 包成 Orchestrator 认的 AgentRunner。
 *
 * 复用指南 §6：这层只做 glue——角色 → prompt/tools/cwd、收结果、收 usage。
 * 不重写 Agent Loop，不定义新的 Runtime 事件协议。
 *
 * 两个必须挡住假成功的地方（架构路线 §34：不依赖人工观察 LLM 文本判断成功）：
 *
 * 1. **Pi 的 `prompt()` 在 provider 报错时也会 resolve。** 会话里最后一条 assistant
 *    消息会带 `stopReason: "error"` 和 `errorMessage`，content 为空。只看 "promise 没 reject"
 *    就会把一次 Connection error 报成任务成功。这里显式检查。
 * 2. **写角色的任务如果没改动任何文件，不算成功。** “Agent 说自己做完了”不是证据，
 *    changedFiles 才是。
 *
 * 角色指令通过 Pi ResourceLoader 注入 system prompt。
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSakuraAgent } from "./create-agent.ts";
import { observeAgent, providerFailure } from "./agent-events.ts";
import type { SakuraAgentConfig } from "./agent-config.ts";
import { collectDiff, type AgentSession } from "../workspace/worktree.ts";
import { agentProfile } from "../orchestrator/agent-registry.ts";
import type { RunTrace } from "../telemetry/trace.ts";
import type { AgentRole } from "../planning/schemas.ts";
import type { AgentRunner, AgentRunInput, AgentRunResult } from "../orchestrator/agent-runner.ts";

export interface PiAgentRunnerOptions {
	/** 透传给 createSakuraAgent 的模型 / thinking / session 配置 */
	config?: Partial<SakuraAgentConfig>;
	/** 追加到任务 prompt 的说明，例如“只改 writeScope 内的文件” */
	extraInstructions?: string;
	/** 给了就把 Pi 的 Session 事件实时转发进 trace（复用指南 §6） */
	trace?: RunTrace;
	onActiveSession?: (taskId:string, session:import("@earendil-works/pi-coding-agent").AgentSession) => (()=>void);
	resumeSessions?: Record<string, string>;
	onSession?: (taskId: string, sessionFile: string | undefined) => Promise<void>;
}

export function createPiAgentRunner(options: PiAgentRunnerOptions = {}): AgentRunner {
	return {
		async run(input: AgentRunInput): Promise<AgentRunResult> {
			input.signal?.throwIfAborted();
			const profile = agentProfile(input.role);
			const denied: string[] = [];
			const effectiveTools=options.config?.allowedTools ? input.allowedTools.filter(tool=>options.config!.allowedTools!.includes(tool)) : input.allowedTools;
			const agent = await createSakuraAgent({
				role: input.role,
				cwd: input.workspacePath,
				sessionMode: "file",
				...options.config,
        signal:input.signal??options.config?.signal,
        allowedTools:effectiveTools,
				...(options.resumeSessions?.[input.task.id] ? {sessionManager:SessionManager.open(options.resumeSessions[input.task.id], undefined, input.workspacePath)} : {}),
				policy: { ...options.config?.policy, workspacePath: input.workspacePath, readScope: input.task.readScope, writeScope: input.task.writeScope },
				onEvent: (event) => {
					options.trace?.emit(event);
					if (event.type === "policy.decision" && event.decision === "deny") denied.push(`${event.tool}: ${event.reason}`);
				},
			});

			// Pi 的事件是公开契约，tool call 和 token 都从这里来（不扫 messages）
			const observation = observeAgent(agent.session, { trace: options.trace, agentId: input.agentId });

			const detach = options.onActiveSession?.(input.task.id, agent.session);
			try {
				await options.onSession?.(input.task.id, agent.session.sessionFile);
				options.config?.budget?.check();
				await promptWithCancellation(agent.session, buildPrompt(input, options.extraInstructions,effectiveTools), input.timeoutMs, input.signal);
				options.config?.budget?.check();
				const collected = await collect(input.workspacePath, input.baseCommit);
				const usage = observation.usage();
				const verdict = verdictOf({
					role: input.role,
					taskId: input.task.id,
					workspacePath: input.workspacePath,
					messages: agent.session.messages,
					collected,
				});

				return {
					status: denied.length ? "failure" : verdict.status,
					summary: denied.length ? `Policy denied execution: ${denied.join("; ")}` : verdict.summary,
					changedFiles: collected.changedFiles,
					diff: verdict.status === "success" ? collected.diff : undefined,
					evidence: [
						...verdict.evidence,
						`allowed tools: ${effectiveTools.join(", ")}`,
						`used tools: ${usage.tools.join(", ") || "none"}`,
					],
					toolCalls: usage.toolCalls,
					toolCallsTraced: Boolean(options.trace),
					usage: { input: usage.tokensIn, output: usage.tokensOut },
				};
			} catch (error) {
				const collected = await collect(input.workspacePath, input.baseCommit);
				const usage = observation.usage();
				return {
					status: "failure",
					summary: error instanceof Error ? error.message : String(error),
					changedFiles: collected.changedFiles,
					evidence: [`role: ${profile.role}`, `used tools: ${usage.tools.join(", ") || "none"}`],
					toolCalls: usage.toolCalls,
					toolCallsTraced: Boolean(options.trace),
					usage: { input: usage.tokensIn, output: usage.tokensOut },
				};
			} finally {
				detach?.();
				observation.unsubscribe();
				agent.dispose();
			}
		},
	};
}

function buildPrompt(input: AgentRunInput, extra?: string,tools=input.allowedTools): string {
	const sections = [
		`# Task (${input.task.id})\n${input.task.title}\n\n${input.task.description}`,
		`# Tools\n实际可用工具：${tools.join(", ")||"none"}。只调用这些工具；没有 shell 时不要声称运行了命令，外层会统一验证。路径优先使用相对当前工作目录的路径。`,
		input.task.readScope?.length ? `# Read scope\n只能读取以下路径内的文件（不要列出范围外的父目录）：\n${input.task.readScope.join("\n")}` : "",
		input.task.writeScope?.length
			? `# Write scope\n只能修改以下路径内的文件：\n${input.task.writeScope.join("\n")}`
			: "",
		input.context ? `# Context\n${input.context}` : "",
		extra ?? "",
		"结束前用一句话总结：改了什么、跑了什么命令、还剩什么问题。",
	];
	return sections.filter(Boolean).join("\n\n");
}

/** Abort waits for native tool/provider shutdown before returning control to artifact cleanup. */
async function promptWithCancellation(session: import("@earendil-works/pi-coding-agent").AgentSession, prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let stopped: Error | undefined;
  let aborting: Promise<void> | undefined;
  const stop = (error: Error) => { stopped ??= error; aborting ??= session.abort(); };
  const onAbort = () => stop(new DOMException("Task cancelled", "AbortError"));
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop(new Error(`agent timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    await session.prompt(prompt);
    if (aborting) await aborting;
    if (stopped) throw stopped;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (aborting) await aborting;
  }
}

/** 复用 worktree.ts 的 diff 收集：`collectDiff` 会把 changedFiles 写回 session。 */
interface Collected {
	changedFiles: string[];
	diff?: string;
	/** git 不可用时的原因。有值就表示“改动文件未知”，不能当成“没有改动”。 */
	unknown?: string;
}

async function collect(cwd: string, baseCommit?: string): Promise<Collected> {
	const session = { worktreePath: cwd, baseCommit, changedFiles: [] } as unknown as AgentSession;
	try {
		const diff = await collectDiff(session);
		return { changedFiles: session.changedFiles, diff };
	} catch (error) {
		return { changedFiles: [], unknown: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 一次 Agent run 算不算成功。纯函数，所以不烧 token 就能测。
 *
 * 三条规则，缺一条就会出假成功：
 *   1. provider 报错（Pi 的 `prompt()` 不会 reject）→ failure
 *   2. 拿不到 changedFiles（git 不可用）→ failure，不能当成“没有改动”
 *   3. 写角色改了 0 个文件 → failure
 */
export function verdictOf(input: {
	role: AgentRole;
	taskId: string;
	workspacePath: string;
	messages: readonly unknown[];
	collected: { changedFiles: string[]; unknown?: string };
}): { status: "success" | "failure"; summary: string; evidence: string[] } {
	const failure = providerFailure(input.messages);
	if (failure) return { status: "failure", summary: failure, evidence: [`role: ${input.role}`] };

	const { changedFiles, unknown } = input.collected;
	if (agentProfile(input.role).writes && (changedFiles.length === 0 || unknown)) {
		return {
			status: "failure",
			summary: unknown
				? `${input.taskId}: 无法确定改动文件（${unknown.trim().split("\n")[0]}）——没有证据就不能算完成`
				: `${input.taskId}: 写角色没有改动任何文件（workspace: ${input.workspacePath}）`,
			evidence: [`role: ${input.role}`, unknown ? "git unavailable" : "no changed files"],
		};
	}

	return {
		status: "success",
		summary: lastAssistantText(input.messages)
			? `模型自述（执行事实以工具轨迹和外层检查为准）：${lastAssistantText(input.messages)}`
			: `${input.taskId} finished without a summary`,
		evidence: [`role: ${input.role}`, `changed: ${changedFiles.length} file(s)`],
	};
}


/** 取最后一条 assistant 文本，作为任务 summary 与 evidence。 */
export function lastAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: string; content?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			const text = message.content
				.filter((part): part is { type: "text"; text: string } => (part as { type?: string })?.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (text) return text;
		}
	}
	return "";
}
