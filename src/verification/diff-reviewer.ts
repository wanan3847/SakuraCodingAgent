/**
 * Diff 审查：验证循环里“代码真的被看过”的那一步。架构文档 §13。
 *
 * 不判断代码好不好（那是 reviewer Agent 的事），只抓机械性问题：
 * 改了 writeScope 之外的文件、碰了受保护文件、改了不该改的文案。
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);

export interface DiffReviewOptions {
	/** 本任务允许改的路径前缀；空表示不限制 */
	writeScope?: string[];
	/** 命中即报问题的路径模式 */
	protectedPaths?: RegExp[];
}

export function createDiffReviewer(options: DiffReviewOptions = {}): (cwd: string) => Promise<string[]> {
	const protectedPaths = options.protectedPaths ?? [/\.env(\.|$)/, /\.ssh\//, /id_rsa/, /\.pem$/];

	return async (cwd) => {
		const files = await changedFiles(cwd);
		const findings: string[] = [];

		for (const file of files) {
			if (protectedPaths.some((pattern) => pattern.test(file))) {
				findings.push(`protected file modified: ${file}`);
			}
			if (options.writeScope?.length && !options.writeScope.some((scope) => file.startsWith(scope.replace(/\/+$/, "")))) {
				findings.push(`file modified outside write scope: ${file}`);
			}
		}
		return findings;
	};
}

/**
 * 不是 git 仓库 / git 不可用时返回空数组，不抛。
 *
 * 根因修在这里：所有调用者（verifier 的 reviewDiff、AgentRunner 收 diff、CLI verify）
 * 都会经过这里，各自 try/catch 一遍只会让“没有 git”变成一个到处都要记得处理的形状。
 * 代价是“不是仓库”和“干净仓库”长得一样，所以只返回文件列表，不声称“已审查”。
 */
export async function changedFiles(cwd: string): Promise<string[]> {
	try {
		const { stdout } = await run("git status --porcelain", { cwd });
		return stdout
			.split("\n")
			.map((line) => line.slice(3).trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}
