/**
 * Experience 抽取：从 trace + 任务结果里提炼可复用经验。预留框架（W7-02）。
 *
 * 原则（架构文档 §15）：Trace → Experience → Retrieval → Candidate Skill → Evaluation →
 * Human Approval → Learned Skill。不允许模型自动修改核心 prompt 或正式 Skill。
 */

import type { Experience } from "./store.ts";
import type { TaskGraph } from "../planning/schemas.ts";
import type { VerificationResult } from "../verification/verifier.ts";

export interface ExtractionInput {
	graph: TaskGraph;
	runId?:string;
	traceDir?:string;
	usedTools?:string[];
	verification?: VerificationResult;
	/** 最终成功时的关键动作文本（来自 trace/agent summary） */
	successfulActions: string[];
	/** 失败任务的 summary */
	failedAttempts: string[];
}

export interface ExperienceExtractor {
	extract(input: ExtractionInput): Experience[];
}

/**
 * 确定性抽取（W7-02）：从失败节点 / 成功节点 / 验证证据里提炼一条 Experience。
 *
 * 不用模型：模型抽取会把“猜的因果”写进经验库，而经验库是要被后续任务当事实检索的。
 * 这里只搬事实（谁失败了、谁成功了、跑了哪些命令、改了什么文件），因果留给评审晋升阶段。
 */
export function createExperienceExtractor(): ExperienceExtractor {
	return {
		extract(input) {
			const nodes = Object.values(input.graph.nodes);
			const failed = nodes.filter((node) => node.status === "failed" || node.status === "cancelled");
			const succeeded = nodes.filter((node) => node.status === "succeeded");
			const failedAttempts = [...input.failedAttempts, ...failed.map((node) => node.result?.summary ?? node.title)];
			const successfulActions = [...input.successfulActions, ...succeeded.map((node) => node.result?.summary ?? node.title)];

			const relevantFiles = [...new Set(nodes.flatMap((node) => node.result?.changedFiles ?? []))];
			const evidence = input.verification?.steps.map((step) => `${step.command} → exit ${step.exitCode} ${step.durationMs}ms`) ?? [];

			// 没有失败也没有证据的 run 不进库：它教不了后面任何一个任务什么。
			if (!failedAttempts.length && !evidence.length) return [];

			return [
				{
					id: `${input.graph.id}-v${input.graph.version}`,
					problemPattern: input.graph.rootTask,
          runId:input.runId,traceDir:input.traceDir,
					symptoms: failed.map((node) => `${node.role}: ${node.result?.summary ?? node.title}`),
					failedAttempts,
					successfulActions,
					usefulTools: [...new Set(input.usedTools ?? [])],
					relevantFiles,
					verificationEvidence: evidence,
					tags: [`nodes:${nodes.length}`, input.verification ? (input.verification.passed ? "verified" : "unverified") : "no-verification"],
					createdAt: Date.now(),
				},
			];
		},
	};
}
