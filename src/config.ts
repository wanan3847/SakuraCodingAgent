/**
 * sakura.config.yaml 的读取。架构文档 §25。
 *
 * 只做一件事：把 yaml 合到默认值上，并把不合法的值挡在入口处。
 * 不引配置框架（不需要 schema 库、不需要多环境继承）——第一版只有一份文件。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export const CONFIG_FILE = "sakura.config.yaml";

export interface SakuraConfig {
	runtime: { maxConcurrency: number; taskTimeoutMs: number; localOnly: boolean; budget?:import('./runtime/run-budget.ts').BudgetLimits };
	planning: { maxTasks: number; maxReplans: number };
	repository: { maxIndexedFileSizeKb: number; indexOnRun: boolean };
	context: { topKFiles: number; inputTokens:number; outputReserve:number };
	workspace: { mode: "worktree" | "in-place"; cleanup: boolean; taskIsolation:boolean };
	verification: { requireDiffReview: boolean; requireTestsWhenAvailable: boolean; commands?:string[] };
	policy: { gitPush: "approval" | "deny"; externalWrite: "deny" | "approval"; network: "allow" | "deny" | "approval" };
	experience: { enabled: boolean; autoCreateSkill: boolean };
	trace: { dir: string };
}

export const DEFAULT_CONFIG: SakuraConfig = {
	runtime: { maxConcurrency: 3, taskTimeoutMs: 600_000, localOnly: true },
	planning: { maxTasks: 12, maxReplans: 3 },
	repository: { maxIndexedFileSizeKb: 512, indexOnRun: true },
	context: { topKFiles: 12, inputTokens:8192, outputReserve:2048 },
	workspace: { mode: "worktree", cleanup: true, taskIsolation:false },
	verification: { requireDiffReview: true, requireTestsWhenAvailable: true },
	policy: { gitPush: "approval", externalWrite: "deny", network: "approval" },
	experience: { enabled: true, autoCreateSkill: false },
	trace: { dir: ".sakura/runs" },
};

function positive(value: unknown, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${CONFIG_FILE}: ${label} must be a positive number, got ${JSON.stringify(value)}`);
	}
	return value;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string): T {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new Error(`${CONFIG_FILE}: ${label} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(value)}`);
	}
	return value as T;
}

function boolean(value: unknown, fallback: boolean): boolean {
	if(value===undefined)return fallback;
	if(typeof value!=='boolean')throw new Error(`${CONFIG_FILE}: expected boolean`);
	return value;
}

function commands(value:unknown):string[]|undefined{
 if(value===undefined)return undefined;
 if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!item.trim()||item.includes('\0')))throw new Error(`${CONFIG_FILE}: verification.commands must be an array of nonempty commands`);
 return value;
}
function budget(value:unknown):import('./runtime/run-budget.ts').BudgetLimits|undefined{
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${CONFIG_FILE}: runtime.budget must be an object`);
 const result:import('./runtime/run-budget.ts').BudgetLimits={};
 for(const key of ['maxTokens','maxToolCalls','maxCostUsd'] as const){const v=(value as Record<string,unknown>)[key];if(v!==undefined){const n=positive(v,1,`runtime.budget.${key}`);if(key!=='maxCostUsd'&&!Number.isSafeInteger(n))throw new Error(`${key} must be an integer`);result[key]=n;}}
 return result;
}

/** 未知键直接忽略（向前兼容），已知键的坏值直接报错（不要静默降级成默认值）。 */
export function mergeConfig(raw: unknown): SakuraConfig {
	const input = (raw ?? {}) as Record<string, Record<string, unknown> | undefined>;
	const group = (name: string) => input[name] ?? {};
	const runtime = group("runtime");
	const planning = group("planning");
	const repository = group("repository");
	const context = group("context");
	const workspace = group("workspace");
	const verification = group("verification");
	const policy = group("policy");
	const experience = group("experience");
	const trace = group("trace");

	return {
		runtime: {
			maxConcurrency: positive(runtime.maxConcurrency, DEFAULT_CONFIG.runtime.maxConcurrency, "runtime.maxConcurrency"),
			taskTimeoutMs: positive(runtime.taskTimeoutMs, DEFAULT_CONFIG.runtime.taskTimeoutMs, "runtime.taskTimeoutMs"),
			localOnly: boolean(runtime.localOnly, DEFAULT_CONFIG.runtime.localOnly),
			budget:budget(runtime.budget),
		},
		planning: {
			maxTasks: positive(planning.maxTasks, DEFAULT_CONFIG.planning.maxTasks, "planning.maxTasks"),
			maxReplans: positive(planning.maxReplans, DEFAULT_CONFIG.planning.maxReplans, "planning.maxReplans"),
		},
		repository: {
			maxIndexedFileSizeKb: positive(
				repository.maxIndexedFileSizeKb,
				DEFAULT_CONFIG.repository.maxIndexedFileSizeKb,
				"repository.maxIndexedFileSizeKb",
			),
			indexOnRun: boolean(repository.indexOnRun, DEFAULT_CONFIG.repository.indexOnRun),
		},
		context: { topKFiles: positive(context.topKFiles, DEFAULT_CONFIG.context.topKFiles, "context.topKFiles"), inputTokens:positive(context.inputTokens,DEFAULT_CONFIG.context.inputTokens,"context.inputTokens"), outputReserve:positive(context.outputReserve,DEFAULT_CONFIG.context.outputReserve,"context.outputReserve") },
		workspace: {
			mode: pick(workspace.mode, ["worktree", "in-place"] as const, DEFAULT_CONFIG.workspace.mode, "workspace.mode"),
			cleanup: boolean(workspace.cleanup, DEFAULT_CONFIG.workspace.cleanup),
      taskIsolation:boolean(workspace.taskIsolation,DEFAULT_CONFIG.workspace.taskIsolation),
		},
		verification: {
			commands:commands(verification.commands),
			requireDiffReview: boolean(verification.requireDiffReview, DEFAULT_CONFIG.verification.requireDiffReview),
			requireTestsWhenAvailable: boolean(
				verification.requireTestsWhenAvailable,
				DEFAULT_CONFIG.verification.requireTestsWhenAvailable,
			),
		},
		policy: {
			gitPush: pick(policy.gitPush, ["approval", "deny"] as const, DEFAULT_CONFIG.policy.gitPush, "policy.gitPush"),
			externalWrite: pick(
				policy.externalWrite,
				["deny", "approval"] as const,
				DEFAULT_CONFIG.policy.externalWrite,
				"policy.externalWrite",
			),
			network: pick(policy.network, ["allow", "deny", "approval"] as const, DEFAULT_CONFIG.policy.network, "policy.network"),
		},
		experience: {
			enabled: boolean(experience.enabled, DEFAULT_CONFIG.experience.enabled),
			autoCreateSkill: boolean(experience.autoCreateSkill, DEFAULT_CONFIG.experience.autoCreateSkill),
		},
		trace: { dir: typeof trace.dir === "string" ? trace.dir : DEFAULT_CONFIG.trace.dir },
	};
}

/** 文件不存在就用默认值；存在但坏掉就报错。 */
export async function loadConfig(cwd: string, path = join(cwd, CONFIG_FILE)): Promise<SakuraConfig> {
	try {
		return mergeConfig(parseYaml(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
		throw error;
	}
}

if (process.argv[1]?.endsWith("config.ts")) {
	// 自检：合并逻辑坏掉时这里会先炸，而不是等到编排中途才炸
	const merged = mergeConfig({ runtime: { maxConcurrency: 5 } });
	console.assert(merged.runtime.maxConcurrency === 5, "override must win");
	console.assert(merged.planning.maxReplans === DEFAULT_CONFIG.planning.maxReplans, "missing key must fall back");
	console.assert(mergeConfig(undefined).runtime.maxConcurrency === 3, "empty config must equal defaults");
	let threw = false;
	try {
		mergeConfig({ runtime: { maxConcurrency: -1 } });
	} catch {
		threw = true;
	}
	console.assert(threw, "invalid value must throw");
	console.log("config self-check ok");
}
