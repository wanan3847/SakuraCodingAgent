/**
 * 权限策略层。架构文档 §12。
 *
 * Worktree 只解决文件互相污染，不等于 Sandbox。这里只用路径和命令规则约束，
 * 容器级隔离不做（架构文档 §30）。
 */

export interface ToolAction {
	agentId: string;
	tool: string;
	/** read / write / exec / network 之类，由调用方从工具描述映射 */
	kind: "read" | "write" | "exec" | "network" | "git";
	path?: string;
	command?: string;
}

export type PolicyDecision = { type: "allow" } | { type: "deny"; reason: string } | { type: "approval"; reason: string };

export interface ToolPolicyConfig {
	workspacePath: string;
	/** workspace 外读是否允许，默认拒绝（读源码是探索的一部分） */
	allowExternalRead?: boolean;
	externalWrite?:"deny"|"approval";
	network?: "allow" | "deny" | "approval";
	/** 命中即需要人工确认的命令模式 */
	destructivePatterns?: RegExp[];
	/** 命中即拒绝的路径模式（密钥、CI 配置等） */
	protectedPaths?: RegExp[];
	/** git push 的处理方式，默认 approval（sakura.config.yaml 的 policy.gitPush） */
	gitPush?: "approval" | "deny";
}

export interface ToolPolicy {
	evaluate(action: ToolAction): PolicyDecision;
}

const DEFAULT_DESTRUCTIVE = [/^git\s+push/, /rm\s+-rf\s+\//, /git\s+reset\s+--hard/, /chmod\s+-R\s+777/];
const DEFAULT_PROTECTED = [/\.env(\.|$)/, /\/\.ssh\//, /id_rsa/, /\.pem$/, /credentials/];

export function createToolPolicy(config: ToolPolicyConfig): ToolPolicy {
	const destructive = config.destructivePatterns ?? DEFAULT_DESTRUCTIVE;
	const protectedPaths = config.protectedPaths ?? DEFAULT_PROTECTED;
	const network = config.network ?? "approval";

	return {
		evaluate(action) {
			if (action.path) {
				const inside = isInside(config.workspacePath, action.path);
				if (protectedPaths.some((pattern) => pattern.test(action.path as string))) {
					return { type: "deny", reason: `protected path: ${action.path}` };
				}
				if (action.kind === "write" && !inside) {
					return { type:config.externalWrite === "approval" ? "approval" : "deny", reason: `write outside workspace: ${action.path}` };
				}
				if (action.kind === "read" && !inside && !config.allowExternalRead) {
					return { type: "deny", reason: `read outside workspace: ${action.path}` };
				}
			}

			if (action.kind === "network") {
				return network === "allow" ? { type: "allow" } : network === "deny" ? { type: "deny", reason: "network denied" } : { type: "approval", reason: "network access" };
			}

			if (action.kind === "git" && action.command?.startsWith("git push")) {
				return config.gitPush === "deny"
					? { type: "deny", reason: "git push denied by policy" }
					: { type: "approval", reason: "git push requires approval" };
			}

			if (action.command && destructive.some((pattern) => pattern.test(action.command as string))) {
				return { type: "approval", reason: `destructive command: ${action.command}` };
			}

			return { type: "allow" };
		},
	};
}

function isInside(workspacePath: string, path: string): boolean {
	const root = workspacePath.replace(/\/+$/, "");
	return path === root || path.startsWith(`${root}/`);
}
