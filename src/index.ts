/**
 * Sakura 公共 API。外部（CLI / Pi extension）只从这里 import。
 * 显式列名而不是 export *：不同模块有同名类型时早报错，而不是静默覆盖。
 */

// planning —— 核心 1：Dynamic Planning
export type { TaskGraph, TaskNode, TaskResult, TaskStatus, AgentRole, VerificationSpec, VerificationKind } from "./planning/schemas.ts";
export { createTaskGraph, buildEdges, taskNode } from "./planning/schemas.ts";
export { validateGraph, getReadyTasks, isGraphFinished, failedTasks, writeScopesConflict, topoLayers, findCycle } from "./planning/dag.ts";
export { analyzeTask, pipelineFor } from "./planning/task-analyzer.ts";
export type { TaskAnalysis, TaskType, Complexity, Risk, AgentRolePlan } from "./planning/task-analyzer.ts";
export type { Planner, PlannerInput } from "./planning/planner.ts";
export { createHeuristicPlanner, planFromToolParams, plannerPrompt } from "./planning/planner.ts";
export type { PlanToolParams, SubmitPlanResult } from "./planning/planner.ts";
export type { Replanner, ReplanInput, ReplanResult } from "./planning/replanner.ts";
export { createReplanner } from "./planning/replanner.ts";
export { validatePlannerOutput } from "./planning/validator.ts";

// orchestrator —— 核心 2：Multi-Agent Orchestrator
export { runGraph } from "./orchestrator/scheduler.ts";
export type { SchedulerOptions, SchedulerEvent, SchedulerOutcome } from "./orchestrator/scheduler.ts";
export { runSakuraTask } from "./orchestrator/orchestrator.ts";
export type { OrchestratorDeps, OrchestratorInput, OrchestratorResult } from "./orchestrator/orchestrator.ts";
export { delegateTasks, cleanupDelegation, renderDelegation } from "./orchestrator/delegate.ts";
export type { DelegateOptions, DelegateOutcome, DelegateTaskSpec, DelegatedTask } from "./orchestrator/delegate.ts";
export { agentProfile, AGENT_PROFILES } from "./orchestrator/agent-registry.ts";
export type { AgentProfile } from "./orchestrator/agent-registry.ts";
export { createFakeAgentRunner } from "./orchestrator/agent-runner.ts";
export type { AgentRunner, AgentRunInput, AgentRunResult } from "./orchestrator/agent-runner.ts";
export { asTaskRunner } from "./orchestrator/agent-runner.ts";

// repo-intelligence —— 核心 3：Repository Intelligence
export { SymbolIndex } from "./repo-intelligence/symbol-index.ts";
export type { SymbolNode, SymbolKind, RepoEdge, RepoEdgeKind } from "./repo-intelligence/symbol-index.ts";
export { indexRepository } from "./repo-intelligence/indexer.ts";
export type { IndexOptions, IndexResult } from "./repo-intelligence/indexer.ts";
export { createTypeScriptParser, resolveRelative, resolveImportEdges, TYPESCRIPT_EXTENSIONS } from "./repo-intelligence/parser.ts";
export type { LanguageParser, ParsedFile } from "./repo-intelligence/parser.ts";
export { mapTests, isTestFile, sourceStem } from "./repo-intelligence/test-mapper.ts";
export { analyzeImpact, formatImpact } from "./repo-intelligence/impact-analysis.ts";
export type { ImpactReport } from "./repo-intelligence/impact-analysis.ts";
export { rankCandidates, isIgnored, DEFAULT_IGNORES, DEFAULT_WEIGHTS } from "./repo-intelligence/retrieval.ts";
export type { Candidate, RankOptions } from "./repo-intelligence/retrieval.ts";

// workspace —— 核心 4：Worktree / Sandbox
export { createWorkspace, collectDiff, cleanupWorkspace, detectConflict } from "./workspace/worktree.ts";
export type { AgentSession, ConflictReport } from "./workspace/worktree.ts";
export { createWorkspaceManager } from "./workspace/workspace-manager.ts";
export type { WorkspaceManager, WorkspaceManagerConfig } from "./workspace/workspace-manager.ts";
export { createToolPolicy } from "./workspace/sandbox-policy.ts";
export type { ToolAction, ToolPolicy, PolicyDecision, ToolPolicyConfig } from "./workspace/sandbox-policy.ts";

// experience —— 核心 5：Experience / Skill Evolution
export { createExperienceStore } from "./experience/store.ts";
export type { Experience, ExperienceStore } from "./experience/store.ts";
export { retrieveExperience, experienceContext } from "./experience/retrieval.ts";
export type { ExperienceHit, ExperienceQuery } from "./experience/retrieval.ts";
export { createExperienceExtractor } from "./experience/extractor.ts";
export type { ExperienceExtractor, ExtractionInput } from "./experience/extractor.ts";
// verification —— 公共闭环，不是第六个创新模块
export { detectVerificationPlan, toCommandSequence } from "./verification/command-detector.ts";
export type { VerificationPlan } from "./verification/command-detector.ts";
export { verify, tailOf } from "./verification/verifier.ts";
export type { VerificationResult, VerificationStep, VerificationFailure, CommandRunner, VerifyOptions } from "./verification/verifier.ts";
export { classifyFailure } from "./verification/failure-classifier.ts";
export type { FailureAction } from "./verification/failure-classifier.ts";
export { createShellCommandRunner, createVerificationCommandRunner } from "./verification/test-runner.ts";
export { createDiffReviewer, changedFiles } from "./verification/diff-reviewer.ts";
export type { DiffReviewOptions } from "./verification/diff-reviewer.ts";

// workspace artifacts
export { applyArtifact, readArtifact } from "./workspace/apply-artifact.ts";
export type { ApplyResult } from "./workspace/apply-artifact.ts";
export { captureChanges, saveArtifact } from "./workspace/artifacts.ts";
export type { WorkspaceChanges, WorkspaceArtifact } from "./workspace/artifacts.ts";

// telemetry
export { createRunTrace } from "./telemetry/trace.ts";
export type { RunTrace } from "./telemetry/trace.ts";
export { emptyMetrics, reduceMetrics } from "./telemetry/events.ts";
export type { SakuraEvent, SakuraEventType, TracedEvent, RunMetrics } from "./telemetry/events.ts";

// runtime —— 唯一的 Pi 集成层
export { configForRole } from "./runtime/agent-config.ts";
export type { SakuraAgentConfig, ThinkingLevelName } from "./runtime/agent-config.ts";
export { createSakuraAgent } from "./runtime/create-agent.ts";
export type { SakuraAgent } from "./runtime/create-agent.ts";
export { observeAgent, providerFailure } from "./runtime/agent-events.ts";
export type { ObserveOptions, AgentObservation, AgentUsage } from "./runtime/agent-events.ts";
export { createPiAgentRunner, verdictOf } from "./runtime/pi-agent-runner.ts";
export type { PiAgentRunnerOptions } from "./runtime/pi-agent-runner.ts";
export { createSessionPlanner, createSubmitPlanTool, createResilientPlanner } from "./runtime/plan-agent.ts";
export type { SessionPlannerOptions } from "./runtime/plan-agent.ts";
export type { PiCustomTool } from "./runtime/create-agent.ts";
export {
	createRunState,
	syncTasks,
	recordVerification,
	recordWorkspace,
	recordExperienceCandidates,
	saveRunState,
	loadRunState,
} from "./runtime/run-state.ts";
export type { SakuraRunState, TaskExecutionState, WorkspaceRef, VerificationRecord } from "./runtime/run-state.ts";

// skills —— 只做选择（复用指南 §9.2），不重写 Pi 的 Skill 加载系统
export { loadSkillCatalog, parseSkillFile } from "./skills/registry.ts";
export type { SkillMeta } from "./skills/registry.ts";
export { routeSkills } from "./skills/router.ts";
export type { SkillQuery, SkillRoute } from "./skills/router.ts";
export { loadSkillBody, loadSkillReferences, stripFrontmatter } from "./skills/loader.ts";

// run —— 一次完整 run 的接线（CLI 与 Pi 扩展共用一份）
export { runSakuraTaskOnce, renderReport } from "./run.ts";
export type { RunOptions, RunOutcome } from "./run.ts";

// telemetry 只读视图
export { listRuns, newestRunMetrics } from "./telemetry/runs.ts";
export type { RunRef } from "./telemetry/runs.ts";

// config —— sakura.config.yaml（架构文档 §25）
export { loadConfig, mergeConfig, DEFAULT_CONFIG, CONFIG_FILE } from "./config.ts";
export type { SakuraConfig } from "./config.ts";

export { savePlan, loadPlan, assertPlan } from "./planning/plan-store.ts";

export {enqueueRunInstruction} from "./runtime/run-instructions.ts";

export {buildRepositoryContext, packContext, estimateTokens} from "./repo-intelligence/context-pack.ts";

export {createRepositoryParser} from "./repo-intelligence/languages.ts";
export {clusterExperience} from "./experience/patterns.ts";
export {undoCheckpoint} from "./workspace/apply-artifact.ts";
