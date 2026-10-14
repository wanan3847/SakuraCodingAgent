/**
 * Pi 事件 → Sakura Telemetry 的最小转发。复用指南 §6/§8.5：复用 Pi 的 Session 事件作为
 * 在线采集点，不自己造一套 Runtime 事件协议。
 *
 * 为什么不让调用方自己扫 `session.messages` 数 tool call：
 *   - Pi 已经在 `tool_execution_start` 事件里告诉我们每次工具调用了，扫消息是重复实现；
 *   - 扫消息只能事后算，事件能实时进 trace（长任务跑一半也能看进度）；
 *   - 消息形状是 Pi 的内部表示，事件是公开契约。
 *
 * 返回值里带累计量，所以调用方不用再写一份计数器。
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RunTrace } from "../telemetry/trace.ts";

export interface ObserveOptions {
	/** 不传就只做本地累计，不发事件 */
	trace?: RunTrace;
	agentId: string;
	/** 每次拿到 usage 时回调（可选，用于别的账本） */
	onUsage?: (usage: { input?: number; output?: number }) => void;
}

export interface AgentUsage {
	toolCalls: number;
	tokensIn?: number;
	tokensOut?: number;
	/** 见过的工具名，按首次出现顺序。诊断“这个角色到底用了什么”用 */
	tools: string[];
}

export interface AgentObservation {
	usage(): AgentUsage;
	unsubscribe(): void;
}

export function observeAgent(session: AgentSession, options: ObserveOptions): AgentObservation {
	let toolCalls = 0;
	let tokensIn: number | undefined;
	let tokensOut: number | undefined;
	const tools: string[] = [];
	const pendingReads = new Map<string,string>();

	const unsubscribe = session.subscribe((event) => {
		switch (event.type) {
			case "tool_execution_start": {
				toolCalls += 1;
				const name = (event as { toolName?: string }).toolName;
				if (name && !tools.includes(name)) tools.push(name);
				const args=(event as {args?:Record<string,unknown>}).args;
				if(name==="read"&&typeof args?.path==="string") pendingReads.set((event as {toolCallId:string}).toolCallId,args.path);
				options.trace?.emit({ type: "tool.called", agentId: options.agentId, tool: name ?? "unknown",path:typeof args?.path === "string" ? args.path : undefined });
				return;
			}
			case "tool_execution_end": {
				const path=pendingReads.get(event.toolCallId);
				pendingReads.delete(event.toolCallId);
				if(path&&!event.isError)options.trace?.emit({type:"file.read",agentId:options.agentId,path});
				return;
			}
			case "message_end": {
				const usage = extractUsage((event as { message?: unknown }).message);
				if (!usage) return;
				const message=event.message as {provider?:string;model?:string};
				options.trace?.emit({type:"model.usage",agentId:options.agentId,...usage,model:message.provider&&message.model?`${message.provider}/${message.model}`:undefined});
				if(usage.input !== undefined) tokensIn = (tokensIn ?? 0) + usage.input;
				if(usage.output !== undefined) tokensOut = (tokensOut ?? 0) + usage.output;
				options.onUsage?.(usage);
				return;
			}
			default:
				return;
		}
	});

	return { usage: () => ({ toolCalls, tokensIn, tokensOut, tools }), unsubscribe };
}

/**
 * Pi 在 provider 报错时不会 reject `prompt()`：它把错误写进 assistant 消息的
 * `stopReason: "error"` + `errorMessage`，content 为空。
 *
 * 不检查这一条，任何「模型没按预期输出」的失败都会被误报成别的原因——
 * 实测踩到两次：AgentRunner 把 Connection error 报成任务成功；Planner 把
 * provider 401 报成 "did not call submit_plan"（真正的原因是本机没起 Ollama）。
 * 所以判断放在这里一份，两边共用。
 */
export function providerFailure(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: string; stopReason?: string; errorMessage?: string; content?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return `model call failed: ${message.errorMessage ?? "unknown provider error"}`;
		if (message.stopReason && message.content !== undefined && isEmptyContent(message.content)) {
			return `model returned no content (stopReason: ${message.stopReason})`;
		}
		return undefined;
	}
	return "model produced no assistant message";
}

function isEmptyContent(content: unknown): boolean {
	if (Array.isArray(content)) return content.length === 0;
	return content === "" || content === undefined || content === null;
}

function extractUsage(message: unknown): { input?: number; output?: number;cacheRead?:number } | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as { role?: string; usage?: { input?: number; output?: number;cacheRead?:number } };
	if (record.role !== "assistant" || !record.usage) return undefined;
	return { input: record.usage.input, output: record.usage.output,cacheRead:record.usage.cacheRead };
}
