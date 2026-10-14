import {registerSakuraCommand} from '../src/ui/commands.ts';
/**
 * 插件 5/5 —— Experience / Skill Evolution（架构路线 §15 / §31.6）
 *
 * 读写 `.sakura/experience/experiences.jsonl`。检索用的是可解释的 tags/symptom 匹配，
 * 不上 embedding（架构路线 §9.4 的第一版口径）。
 *
 * 边界（架构路线 §15）：这里只负责“存”和“查”。晋升成正式 Skill 必须走
 * candidate → eval → review → promoted，绝不让模型在一次成功之后自动改 SKILL.md。
 * 写入由 orchestrator 插件在验证闭环跑完之后触发。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {clusterExperience} from "../src/experience/patterns.ts";
import { Type } from "typebox";
import { createExperienceStore, retrieveExperience, type Experience } from "../src/index.ts";

function format(hits: Array<{ experience: Experience; score: number }>): string {
	if (!hits.length) return "经验库里没有匹配项。";
	return hits
		.map((hit) => {
			const item = hit.experience;
			return [
				`## ${item.problemPattern} (score ${hit.score})`,
				item.symptoms.length ? `symptoms: ${item.symptoms.join("; ")}` : "",
				item.failedAttempts.length ? `failed: ${item.failedAttempts.join("; ")}` : "",
				item.successfulActions.length ? `worked: ${item.successfulActions.join("; ")}` : "",
				item.verificationEvidence.length ? `evidence: ${item.verificationEvidence.join("; ")}` : "",
				item.relevantFiles.length ? `files: ${item.relevantFiles.join(", ")}` : "",
			]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n\n");
}

export default function sakuraExperience(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sakura_experience",
		label: "Sakura Experience",
		description:
			"Search, list, or record Sakura experience entries (problem pattern → failed attempts → successful actions) from previous runs.",
		promptSnippet: "Search or record Sakura experience from previous runs",
		promptGuidelines: [
			"Use sakura_experience action=search before retrying a problem that previous runs already failed at.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("search"), Type.Literal("list"), Type.Literal("record"),Type.Literal("patterns")], {
				description: "Search by tags/keywords, list everything, or record one entry",
			}),
			query: Type.Optional(Type.String({ description: "Search text (search) or the problem pattern (record)" })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for search filtering or for the recorded entry" })),
			worked: Type.Optional(Type.Array(Type.String(), { description: "What worked (record)" })),
			failed: Type.Optional(Type.Array(Type.String(), { description: "What did not work (record)" })),
		}),
		async execute(_toolCallId, params, _signal, _update, ctx) {
			const store = createExperienceStore(ctx.cwd);

			if (params.action === "record") {
				if (!params.query) return { content: [{ type: "text" as const, text: "record 需要 query 作为 problemPattern" }], isError: true, details: {} };
				const experience: Experience = {
					id: `manual-${Date.now().toString(36)}`,
					problemPattern: params.query,
					symptoms: [],
					failedAttempts: params.failed ?? [],
					successfulActions: params.worked ?? [],
					usefulTools: [],
					relevantFiles: [],
					verificationEvidence: [],
					tags: params.tags ?? [],
					createdAt: Date.now(),
				};
				await store.add(experience);
				return { content: [{ type: "text" as const, text: `recorded ${experience.id}` }], details: {} };
			}

			const all = await store.all();
			if(params.action==="patterns")return {content:[{type:"text",text:JSON.stringify(clusterExperience(all),null,2)}],details:{}};
			if (params.action === "list") {
				return {
					content: [{ type: "text" as const, text: all.length ? all.map((item) => `${item.id}: ${item.problemPattern}`).join("\n") : "经验库是空的。" }],
					details: {},
				};
			}
			const hits = retrieveExperience(all, { task: params.query ?? "", tags: params.tags, limit: 5 });
			return { content: [{ type: "text" as const, text: format(hits) }], details: {} };
		},
	});

	registerSakuraCommand(pi,"sakura-experience", {
		description: "Search Sakura experience: /sakura-experience <query>",
		async handler(args, ctx) {
			const store = createExperienceStore(ctx.cwd);
			const hits = retrieveExperience(await store.all(), { task: args.trim(), limit: 5 });
			ctx.ui.notify(format(hits), "info");
		},
	});
}
