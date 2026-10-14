/**
 * 失败分类：决定“原地重试”还是“回去重规划”。架构文档 §6.4 的触发条件。
 *
 * 现在只认确定性信号（网络/锁文件/超时 → retry，其余 → replan）。
 * TODO(W3-06): 接模型做语义分类，但要保留这里作为兜底：模型挂了也得能分类。
 */

import type { VerificationResult } from "./verifier.ts";

export type FailureAction = "retry" | "replan";

const TRANSIENT = ["timeout", "etimedout", "econnreset", "enotfound", "eai_again", "registry", "lockfile", "429", "503"];

export function classifyFailure(result: VerificationResult): FailureAction {
	if (!result.failures.length) return "retry";
	const text = result.failures.map((failure) => failure.reason).join("\n").toLowerCase();
	return TRANSIENT.some((needle) => text.includes(needle)) ? "retry" : "replan";
}
