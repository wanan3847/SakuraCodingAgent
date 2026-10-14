/**
 * WorkspaceManager：架构文档 §11.2 的接口，落在 worktree.ts 之上。
 *
 * P0 全部就位：建 worktree / 收 diff / 清理 / 重叠文件检测。
 * P1（集成、cherry-pick、语义冲突）留在 integration.ts，未实现。
 */

import {
	cleanupWorkspace,
	collectDiff,
	createWorkspace,
	detectConflict,
	type AgentSession,
	type ConflictReport,
} from "./worktree.ts";

export interface WorkspaceManager {
	createWorkspace(taskId: string): Promise<AgentSession>;
	collectDiff(session: AgentSession): Promise<string>;
	detectConflict(sessions: AgentSession[]): ConflictReport;
	cleanup(session: AgentSession): Promise<void>;
}

export interface WorkspaceManagerConfig {
	repoPath: string;
	rootDir: string;
	baseRef?: string;
}

export function createWorkspaceManager(options: WorkspaceManagerConfig): WorkspaceManager {
	return {
		createWorkspace: (taskId) => createWorkspace(taskId, options.repoPath, options.rootDir, options.baseRef),
		collectDiff,
		detectConflict,
		cleanup: (session) => cleanupWorkspace(session, options.repoPath),
	};
}
