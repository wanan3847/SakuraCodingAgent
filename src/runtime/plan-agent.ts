/**
 * Planner 的 Pi 适配：复用指南 §8.1 —— 用 Pi 的结构化工具注册能力，让 Planner Session
 * 通过 `submit_plan` 提交受校验的 Task DAG。
 *
 * 为什么不是「Planner = 一个 JSON 输出解析器」：Pi 的 customTools 会带 schema 校验和
 * 工具调用语义，模型不用在自由文本里猜格式；而且这套东西 Pi 已经实现好了，我们只提供
 * 工具定义 + 参数校验。
 *
 * 降级策略（架构路线 §29 风险 1 的思路）：模型没调工具、参数不合法、模型不可用——三种情况都
 * 不抛到 run 外面，而是交给 `createResilientPlanner` 回落到确定性 Planner，并把原因记下来。
 * 静默降级不行，所以原因会进 trace。
 */

import { Type } from "typebox";
import type { TaskGraph } from "../planning/schemas.ts";
import { planFromToolParams, plannerPrompt, type PlanToolParams, type Planner, type PlannerInput } from "../planning/planner.ts";
import { createHeuristicPlanner } from "../planning/planner.ts";
import { createSakuraAgent, type PiCustomTool } from "./create-agent.ts";
import { observeAgent, providerFailure } from "./agent-events.ts";
import type { SakuraAgentConfig } from "./agent-config.ts";
import {agentProfile} from "../orchestrator/agent-registry.ts";

const TASK_SCHEMA = Type.Object({
	id: Type.String({ description: "唯一 id，例如 implementer / explore-auth" }),
	title: Type.String({ description: "一行标题" }),
	description: Type.String({ description: "要完成什么（结果，不是步骤）" }),
	role: Type.Union(
		[
			Type.Literal("explorer"),
			Type.Literal("architect"),
			Type.Literal("implementer"),
			Type.Literal("tester"),
			Type.Literal("reviewer"),
			Type.Literal("researcher"),
		],
		{ description: "由哪种角色的 Agent 执行" },
	),
	dependencies: Type.Array(Type.String(), { description: "本任务依赖的 id；必须存在于本次提交中" }),
	priority: Type.Number({ description: "同层内的优先级，越小越先" }),
	writeScope: Type.Optional(Type.Array(Type.String(), { description: "允许写的路径前缀；implementer/tester 必填" })),
	readScope: Type.Optional(Type.Array(Type.String(), { description: "允许读的路径前缀" })),
});

export interface SessionPlannerOptions {
	cwd: string;
	trace?: import("../telemetry/trace.ts").RunTrace;
	/** 透传给 Pi Session 的模型/本地模式配置 */
	config?: Partial<SakuraAgentConfig>;
	timeoutMs?: number;
	/** 超时或失败时是否回落到确定性 Planner，默认 true */
	fallback?: boolean;
	/** 降级/失败原因的去处（trace 或 stderr） */
	onFallback?: (reason: string) => void;
}

/** 纯函数：submit_plan 的工具定义 + 捕获器。可以脱离模型单测校验逻辑。 */
export function createSubmitPlanTool(): { tool: PiCustomTool; captured: () => PlanToolParams | undefined } {
	let captured: PlanToolParams | undefined;
	return {
		captured: () => captured,
		tool: {
			name: "submit_plan",
			label: "Submit plan",
			description: "Submit the task DAG for this work. Call this exactly once with the complete plan.",
			parameters: Type.Object({
				tasks: Type.Array(TASK_SCHEMA, { description: "按依赖排序的任务列表，最多 12 个" }),
				notes: Type.Optional(Type.Array(Type.String(), { description: "你对这个拆法的不确定之处" })),
			}),
			async execute(_toolCallId, params) {
				captured = params as PlanToolParams;
				return { content: [{ type: "text", text: `plan received: ${(params as PlanToolParams).tasks?.length ?? 0} tasks` }], details: {} };
			},
		},
	};
}

/** 模型版 Planner：起一个只带 submit_plan 的 Pi Session。失败会抛，由调用方决定是否降级。 */
export function createSessionPlanner(options: SessionPlannerOptions): Planner {
	return {
		async plan(input: PlannerInput): Promise<TaskGraph> {
			options.config?.signal?.throwIfAborted();
			const { tool, captured } = createSubmitPlanTool();

			// Planner 不读文件也不改文件：上下文由 Sakura 从 Repo Intelligence 喂进来。
			//
			// ⚠️ 白名单必须是 ["submit_plan"] 而不是 []：Pi 的 `tools` 是**统一**白名单，
			// 空数组会把 customTools 也一起挡掉（isAllowTool 对每个工具都返回 false），
			// 结果是模型根本没有 submit_plan 可用，每次规划都静默降级到启发式。
			// 实测踩到过，`tests/integration/pi-runtime.test.ts` 有合同测试锁这条。
			//
			// 调用方可以覆盖模型/thinking，但不能覆盖这里的工具白名单——那是 Planner 的契约。
			const { allowedTools: _ignoredTools, customTools: _ignoredCustomTools, ...overridable } = options.config ?? {};
			const agent = await createSakuraAgent({
				role: "planner",
				cwd: options.cwd,
				sessionMode: "memory",
				...overridable,
				allowedTools: ["submit_plan"],
				customTools: [tool],
			});

			// 先记下工具集合和消息再 dispose：降级原因里带上它们，才能一眼区分
			// “provider 挂了”和“模型没调工具”
			const observation = observeAgent(agent.session,{agentId:"planner",trace:options.trace,onUsage:usage=>options.trace?.emit({type:"task.usage",taskId:"planner",agentId:"planner",tokensIn:usage.input,tokensOut:usage.output})});
      options.trace?.emit({type:"task.started",taskId:"planner",agentId:"planner"});
			const available = agent.session.getActiveToolNames();
			const deadline = (options.timeoutMs ?? 180_000) + Date.now();
			let messages: readonly unknown[] = [];
			let aborting: Promise<void> | undefined;
			const onAbort = () => { aborting ??= agent.session.abort(); };
			options.config?.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.config?.signal?.aborted) onAbort();
			try {
				const ceiling=options.config?.allowedTools;
				const execution=ceiling ? `\n执行节点的工具上限：${ceiling.join(", ")||"none"}。外层自动执行项目验证命令；若没有 bash/powershell，不要安排只运行命令的写角色节点。写角色必须有实际需要修改的文件；已有回归检查足够时无需额外 tester。简单修复可只用一个 implementer。` : "";
				options.config?.budget?.check();
				await within(agent.session.prompt(plannerPrompt(input)+execution), deadline - Date.now(), () => agent.session.abort());
				options.config?.budget?.check();
				options.config?.signal?.throwIfAborted();
				// 模型经常先输出一段思考文本就停了。Pi 的 SDK 没有强制 tool choice 的选项
				// （也不想为此改 Pi），所以用一次明确的追问重试；再失败才降级。
				if (!captured() && deadline > Date.now()) {
					await within(
						agent.session.prompt("立刻调用 submit_plan 提交计划。不要输出任何文本。"),
						deadline - Date.now(),
						() => agent.session.abort(),
					);
				}
			} finally {
				options.config?.signal?.removeEventListener("abort", onAbort);
				if (aborting) await aborting;
				messages = agent.session.messages;
				observation.unsubscribe();
				agent.dispose();
			}

			const params = captured();
			if (!params) {
				// 先把 provider 层面的失败和“模型没调工具”分开报，否则降级原因会指向错误的方向
				const failed = providerFailure(messages);
				throw new Error(
					failed
						? `planner session failed: ${failed} (active tools: ${available.join(", ") || "none"})`
						: `planner did not call submit_plan (active tools: ${available.join(", ") || "none"})`,
				);
			}

			const result = planFromToolParams(params, { graphId: graphIdFor(input), rootTask: input.task });
			if (!result.graph) throw new Error(`planner output rejected: ${result.rejected}`);
			if(input.analysis.type==="research"&&Object.values(result.graph.nodes).some(node=>agentProfile(node.role).writes))throw new Error("planner output rejected: read-only tasks cannot contain write roles");
			return result.graph;
		},
	};
}

/**
 * 先问模型，不行就回落确定性 Planner。
 *
 * 这是默认入口：**降级一定要被看见**——`onFallback` 拿到原因，写进 trace；
 * 否则 Benchmark 会把“模型 Planner 从没成功过”误读成“启发式一样好”。
 */
export function createResilientPlanner(options: SessionPlannerOptions): Planner {
	const fallback = createHeuristicPlanner();
	const session = createSessionPlanner(options);
	return {
		async plan(input) {
			try {
				return await session.plan(input);
			} catch (error) {
				options.config?.signal?.throwIfAborted();
				const reason = error instanceof Error ? error.message : String(error);
				options.onFallback?.(reason);
				if (options.fallback === false) throw error;
				return fallback.plan(input);
			}
		},
	};
}

/**
 * 用任务文本派生稳定的图 id，方便测试和 trace 对比。
 * 只保留 ASCII：图 id 会进文件名（task-graph-v1.json 的邻居、diffs/、日志），
 * 中文 id 在终端和路径里都是噪音。派生不出东西就退回任务类型。
 */
export function graphIdFor(input: Pick<PlannerInput, "task" | "analysis">): string {
	const slug = input.task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 32)
		.replace(/-+$/, "");
	return `plan-${input.analysis.type}${slug ? `-${slug}` : ""}`;
}

async function within<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => Promise<void>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(async () => {
			await onTimeout().catch(() => undefined);
			reject(new Error(`planner timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}
