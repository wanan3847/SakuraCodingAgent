import {registerSakuraCommand,sakuraCommandName} from '../src/ui/commands.ts';
/**
 * 插件 1/5 —— Dynamic Planning（架构路线 §6 / §31.1）
 *
 * 把「复杂度判断 + Task DAG」暴露成 Pi 工具和命令。只做规划，不执行。
 * Planner 的模型版本（W3-04）没接时用确定性 Planner，所以离线可用（架构文档 §35）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { savePlan, analyzeTask, createHeuristicPlanner, topoLayers, validateGraph, type TaskGraph, type TaskAnalysis } from "../src/index.ts";

function render(graph: TaskGraph, analysis: TaskAnalysis, errors: string[]): string {
	const lines = [
		`# Sakura plan — ${graph.id} (v${graph.version})`,
		`analysis: type=${analysis.type} complexity=${analysis.complexity} risk=${analysis.risk} parallelism=${analysis.requiresParallelism}`,
		`tasks: ${Object.keys(graph.nodes).length}`,
		"",
		"## layers (同层可并行)",
	];
	for (const [index, layer] of topoLayers(graph).entries()) {
		lines.push(`${index + 1}. ${layer.join(", ")}`);
	}
	lines.push("", "## tasks");
	for (const node of Object.values(graph.nodes)) {
		const deps = node.dependencies.length ? ` ← ${node.dependencies.join(", ")}` : "";
		const scope = node.writeScope?.length ? ` write=[${node.writeScope.join(", ")}]` : "";
		lines.push(`- ${node.id} (${node.role}) ${node.title}${deps}${scope}`);
	}
	if (errors.length) lines.push("", "## INVALID", ...errors.map((error) => `- ${error}`));
	else lines.push("", "graph valid.");
	return lines.join("\n");
}

async function plan(task: string, files: string[] | undefined, cwd: string): Promise<string> {
	const analysis = analyzeTask({ description: task, hintFiles: files });
	const saved = await savePlan(cwd, await createHeuristicPlanner().plan({ task, analysis }));
	return `${render(saved.graph, analysis, validateGraph(saved.graph))}\nplanner: heuristic\nplanPath: ${saved.path}\n执行：/${sakuraCommandName('sakura-run')} --plan ${saved.path}`;
}

export default function sakuraPlanning(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sakura_plan",
		label: "Sakura Plan",
		description:
			"Decompose a coding task into a dependency-ordered Task DAG (complexity-aware). Use before starting non-trivial work.",
		promptSnippet: "Plan a coding task into a Sakura Task DAG",
		promptGuidelines: [
			"Use sakura_plan before multi-file or cross-module changes to decide which tasks can run in parallel.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The user's coding task in natural language" }),
			files: Type.Optional(Type.Array(Type.String(), { description: "Files the user already mentioned" })),
		}),
		async execute(_toolCallId, params, _signal, _update, ctx) {
			const text = await plan(params.task, params.files, ctx.cwd);
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	registerSakuraCommand(pi,"sakura-plan", {
		description: "Plan a task into a Sakura Task DAG: /sakura-plan <task>",
		async handler(args, ctx) {
			if (!args.trim()) {
				ctx.ui.notify(`usage: /${sakuraCommandName('sakura-plan')} <task>`, 'warning');
				return;
			}
			ctx.ui.notify(await plan(args.trim(), undefined, ctx.cwd), "info");
		},
	});
}
