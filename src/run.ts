/**
 * 一次完整 Sakura run 的接线。CLI 和 Pi 扩展都调这里，不各写一份（否则两边必然漂移）。
 *
 * analyze → 路由技能 → plan(带历史经验) → 隔离工作区 → 依赖感知调度 → 验证 → replan
 * → trace → run state → experience。
 *
 * 集（cherry-pick 回主分支）是 P1，这里不做：只在 .sakura/runs/<id>/diffs/ 留 diff，
 * 由人决定怎么合。宁可显式留一步，也不假装自动合并是安全的。
 *
 * 用到的 Pi 复用点（复用指南 §8/§9/§10）：
 *   - §8.1 Planner：`createResilientPlanner` = Pi Session + `submit_plan` 结构化工具，坏了回落启发式
 *   - §8.2 Orchestrator：每个 Agent 一个绑定 worktree cwd 的 Pi Session，超时走 Pi 的 abort
 *   - §8.5 采集：Pi 的 Session 事件（不是扫 messages）实时进 trace
 *   - §9.2 Skill Router：选技能，不重写加载系统
 *   - §10 Session：run state 只存结构化状态 + Pi Session 引用，不复制聊天记录
 */

import {RunBudget} from "./runtime/run-budget.ts";
import { mkdir, writeFile,readFile,readdir,realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isolateTaskWorkspaces } from "./workspace/task-workspaces.ts";
import { atomicWrite } from "./storage/atomic.ts";
import { buildRepositoryContext, packContext, type ContextPack, type ContextEvidence } from "./repo-intelligence/context-pack.ts";
import { createRunInstructions } from "./runtime/run-instructions.ts";
import { createReplanner } from "./planning/replanner.ts";
import { savePlan, loadPlan } from "./planning/plan-store.ts";
import { createTaskGraph, type TaskGraph } from "./planning/schemas.ts";
import type { SakuraAgentConfig } from "./runtime/agent-config.ts";
import { dirname, join } from "node:path";
import { loadConfig, type SakuraConfig } from "./config.ts";
import { createExperienceExtractor } from "./experience/extractor.ts";
import { createExperienceStore } from "./experience/store.ts";
import { experienceContext } from "./experience/retrieval.ts";
import { analyzeTask, type TaskAnalysis } from "./planning/task-analyzer.ts";
import { createHeuristicPlanner, type Planner, type PlannerInput } from "./planning/planner.ts";
import { validateGraph } from "./planning/dag.ts";
import { asTaskRunner, type AgentRunner } from "./orchestrator/agent-runner.ts";
import { runSakuraTask, type OrchestratorResult } from "./orchestrator/orchestrator.ts";
import { createPiAgentRunner } from "./runtime/pi-agent-runner.ts";
import { createResilientPlanner } from "./runtime/plan-agent.ts";
import {
	createRunState,
	recordExperienceCandidates,
	recordVerification,
	recordWorkspace,
	saveRunState,
	type SakuraRunState,
	loadRunState,
	syncTasks,
} from "./runtime/run-state.ts";
import { loadSkillCatalog } from "./skills/registry.ts";
import { loadSkillReferenceEvidence } from "./skills/loader.ts";
import {controlDirectory,digest,recordTrustedRun,type ControlOptions} from "./experience/control-store.ts";
import {existingActiveSkills} from "./experience/skill-candidates.ts";
import { routeSkills, type SkillRoute } from "./skills/router.ts";
import { createDiffReviewer } from "./verification/diff-reviewer.ts";
import { detectVerificationPlan, toCommandSequence } from "./verification/command-detector.ts";
import { createShellCommandRunner } from "./verification/test-runner.ts";
import {protectedSandboxSupported} from "./verification/protected-command.ts";
import { verify, type VerificationResult } from "./verification/verifier.ts";
import { createWorkspaceManager, type WorkspaceManager } from "./workspace/workspace-manager.ts";
import { enforceAction, type Approval } from "./workspace/guard.ts";
import { readArtifact } from "./workspace/apply-artifact.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureChanges, saveArtifact, type WorkspaceChanges } from "./workspace/artifacts.ts";
import { createRunTrace, type RunTrace } from "./telemetry/trace.ts";
import { emptyMetrics, type RunMetrics, type SakuraEvent } from "./telemetry/events.ts";

export interface RunOptions {
	task: string;
	cwd: string;
	config?:SakuraConfig;
	files?: string[];
	/** 额外要扫描技能目录（默认扫描 <cwd>/skills；扩展会再塞进包内的 skills/） */
	skillDirs?: string[];
	/** Trusted host option, never read from model-editable project configuration. */
	skillAuthority?:ControlOptions;
	/** 不传就用 createPiAgentRunner（需要可用模型） */
	runner?: AgentRunner;
	/** 宿主 Pi Session 的引用，只存 id 不存内容（复用指南 §10） */
	rootPiSessionRef?: string;
	/** Execute the exact saved preview instead of invoking a new planner. */
	planPath?: string;
	resumeRunId?: string;
	planner?: Planner;
	/** Apply an execution constraint to newly generated plans, while retaining the real planner. */
	plannerTransform?:(graph:TaskGraph)=>TaskGraph;
	agentConfig?: Partial<SakuraAgentConfig>;
	signal?: AbortSignal;
	onEvent?: (event: SakuraEvent) => void;
	onProgress?: (message: string) => void;
}

export interface RunOutcome {
	runId: string;
	traceDir: string;
	statePath?: string;
	planPath?: string;
	executionStatus?: "succeeded" | "failed" | "cancelled";
	checkStatus?: "passed" | "failed" | "not_run" | "cancelled";
	applyStatus?: "pending" | "applied" | "conflict";
	artifactPath?: string;
	workspacePath?: string;
	completed: boolean;
	result?: OrchestratorResult;
	metrics: RunMetrics;
	experiences: number;
	diff: string;
	/** 路由选中的技能（进 run state，便于以后做效果追踪） */
	skills: SkillRoute[];
	/** Planner 是否降级到了启发式，以及原因。必须让调用方看见 */
	plannerFallback?: string;
	/** 降级发生了（例如 worktree 不可用），必须让调用方看见 */
	warning?: string;
	/** 跑到一半炸了：这时 result 为空，但 traceDir 里已经有事件 */
	error?: string;
}

export async function runSakuraTaskOnce(options: RunOptions): Promise<RunOutcome> {
	const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
	let resumeState: SakuraRunState | undefined;
  if (options.resumeRunId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.resumeRunId)) throw new Error("Unsafe run id");
    resumeState = await loadRunState(join(options.cwd, ".sakura", "runs", options.resumeRunId));
    const base = resumeState.workspaces[resumeState.runId]?.baseCommit;
    if ((await captureChanges(options.cwd)).diff) throw new Error("Cannot resume with uncommitted target changes");
    if (!base || (await captureChanges(options.cwd)).baseCommit !== base) throw new Error("Cannot resume: repository base changed or checkpoint lacks baseCommit");
  }
  const suppliedPlan = resumeState && Object.keys(resumeState.graph.nodes).length ? structuredClone(resumeState.graph) : options.planPath ? await loadPlan(options.planPath) : undefined;
  if (resumeState && suppliedPlan) {
    suppliedPlan.version += 1;
    for (const task of Object.values(suppliedPlan.nodes)) if (task.status !== "succeeded") { task.status = "pending"; task.retryCount = 0; }
  }
	if (suppliedPlan && suppliedPlan.rootTask !== options.task) throw new Error("Saved plan task does not match the requested task");
	const cfg = options.config ?? await loadConfig(options.cwd);
 const runBudget=options.agentConfig?.budget??new RunBudget(cfg.runtime.budget);
 if(resumeState){
  try{runBudget.restore(JSON.parse(await readFile(join(options.cwd,'.sakura','runs',resumeState.runId,'budget.json'),'utf8')));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if(Object.keys(runBudget.limits).length)throw new Error('Cannot resume a limited run without its saved budget ledger');}
 }
 const signal=options.signal?AbortSignal.any([options.signal,runBudget.signal]):runBudget.signal;
 options={...options,signal,agentConfig:{...options.agentConfig,budget:runBudget}};
	const usedTools=new Set<string>();
	const usedModels=new Set<string>();
	const trace = await createRunTrace(runId, options.cwd, event=>{if(event.type==="tool.called") usedTools.add(event.tool);if(event.type==="model.usage"&&event.model)usedModels.add(event.model);options.onEvent?.(event);});
  const instructions = createRunInstructions(trace.dir, event => trace.emit(event), options.signal);
	trace.emit({ type: "run.phase", phase: "planning", runId });
	

	const workspace = await openWorkspace(cfg, options.cwd, runId);
	trace.emit({ type: "workspace.created", path: workspace.path });

	let plannerFallback: string | undefined;
	let skills: SkillRoute[] = [];
	let diff = "";
	let artifactPath: string | undefined;
	let artifactSaved = false;
	let planPath = options.planPath;
  let state: SakuraRunState = createRunState({ runId, graph: suppliedPlan ?? createTaskGraph({ id:runId, rootTask:options.task, nodes:[] }), rootPiSessionRef:options.rootPiSessionRef });
  state = recordWorkspace(state, { taskId:runId, path:workspace.path, baseCommit:workspace.baseCommit, branch:workspace.branch, fallbackReason:workspace.warning });
  state.phase = "planning";
  let statePath: string | undefined;
  let checkpointTail: Promise<void> = Promise.resolve();
  async function checkpoint(graph?: TaskGraph): Promise<void> {
    if (graph) state.graph = graph;
    state = syncTasks(state);
    const snapshot = structuredClone(state);
    await atomicWrite(join(trace.dir,"budget.json"),JSON.stringify(runBudget.snapshot(),null,2));
    checkpointTail = checkpointTail.then(async () => { statePath = await saveRunState(trace.dir, snapshot); });
    await checkpointTail;
  }


	try {
		await checkpoint();
    if (resumeState) {
      let artifact = resumeState.artifactPath;
      if (!artifact) {
        const previous = resumeState.workspaces[resumeState.runId];
        if (!previous) throw new Error("Cannot resume: no recovery workspace");
        artifact = await saveArtifact(join(trace.dir, "recovery"), "restored", await captureChanges(previous.path, previous.baseCommit));
      }
      await restoreArtifact(workspace.path, artifact);
    }
		options.signal?.throwIfAborted();
		options.onProgress?.(`workspace: ${workspace.path}`);

		// §9.2：先选技能，再规划。选中的技能同时进 Planner prompt 和子 Agent 的 context
		const analysis = analyzeTask({ description: options.task, hintFiles: options.files });
		skills = await selectSkills(options, analysis);
		const loaded=await loadSkillReferenceEvidence(skills.map(route=>route.skill));
		const skillReferences=loaded.text;
		const protectedSkills=Boolean(options.skillAuthority)||skills.some(route=>route.skill.name.startsWith("sakura-learned-"));
		const authorityPath=await realpath(controlDirectory(options.skillAuthority)).catch(error=>{if(error.code!=="ENOENT")throw error;return controlDirectory(options.skillAuthority);});
		const projectRoot=await realpath(options.cwd),executionRoot=await realpath(workspace.path);
		if(protectedSkills&&(executionRoot===projectRoot||!workspace.baseCommit))throw new Error("Protected candidate replay requires an isolated Git worktree; in-place execution and worktree fallback cannot authorize publication");
		const protectedChecks=protectedSkills?{readWriteDeny:[authorityPath],writeDeny:[join(projectRoot,".pi","skills"),join(executionRoot,".pi","skills"),join(projectRoot,".sakura","runs"),join(projectRoot,".sakura","skill-candidates")]}:undefined;
		if(protectedChecks){const probe=await createShellCommandRunner(protectedChecks)("true",workspace.path,options.signal);if(probe.exitCode!==0)throw new Error(`Protected OS sandbox unavailable: ${probe.stderr}`);}
		const agentConfig=protectedSkills?{...options.agentConfig,allowedTools:(options.agentConfig?.allowedTools??["read","write","edit","grep","find","ls"]).filter(tool=>["read","write","edit","grep","find","ls"].includes(tool)),policy:{...options.agentConfig?.policy,workspacePath:workspace.path,trustedPaths:[authorityPath]}}:options.agentConfig;
		if (skills.length) options.onProgress?.(`skills: ${skills.map((route) => route.skill.name).join(", ")}`);

    const experience = cfg.experience.enabled ? await experienceContext(createExperienceStore(options.cwd), options.task) : [];
    const extra:ContextEvidence[] = [
      ...(skillReferences ? [{source:"skills",text:skillReferences,weight:110,estimatedTokens:0}] : []),
      ...experience.map((text,index)=>({source:`experience-${index+1}`,text,weight:105,estimatedTokens:0})),
    ];
    const window = options.agentConfig?.model?.contextWindow ?? 32768;
    const budget = Math.max(0,Math.floor(Math.min(cfg.context.inputTokens,window-cfg.context.outputReserve-4096)));
    let contextPack:ContextPack;
    if(cfg.repository.indexOnRun) {
      const built = await buildRepositoryContext({cwd:workspace.path,task:options.task,files:options.files,topK:cfg.context.topKFiles,maxFileSizeKb:cfg.repository.maxIndexedFileSizeKb,budget,extra,onFileRead:path=>trace.emit({type:"file.read",agentId:"repository-index",path})});
      contextPack=built.pack;
      await atomicWrite(join(trace.dir,"repository-context.json"),JSON.stringify({...built,pack:contextPack},null,2));
    } else contextPack=packContext(extra,budget,"repository.indexOnRun=false; agents use native read/grep.");
    await atomicWrite(join(trace.dir,"context-pack.json"),JSON.stringify(contextPack,null,2));
    const included=contextPack.selected.find(item=>item.source==="skills")?.text??"";let referenceOffset=0;
    state.skillEvidence=loaded.evidence.map(item=>{const evidence={...item,fullyIncluded:item.fullyIncluded&&included.slice(referenceOffset,referenceOffset+item.reference.length)===item.reference};referenceOffset+=item.reference.length+2;return evidence;});
    trace.emit({type:"context.selected",paths:contextPack.selected.flatMap(item=>item.path?[item.path]:[]),estimatedTokens:contextPack.estimatedTokens,budget});

		const baseRunner = options.runner ?? createPiAgentRunner({ config: { localOnly: cfg.runtime.localOnly, ...agentConfig, signal: options.signal, policy: { workspacePath:workspace.path, network:cfg.policy.network, gitPush:cfg.policy.gitPush,externalWrite:cfg.policy.externalWrite,trustedPaths:protectedSkills?[authorityPath]:undefined }, approve:options.agentConfig?.approve }, trace,
      onActiveSession:instructions.attach,
      resumeSessions: resumeState ? Object.fromEntries(Object.values(resumeState.tasks).filter(task => task.status !== "succeeded" && task.piSessionRef).map(task => [task.taskId, task.piSessionRef!])) : undefined,
			onSession: async (taskId, piSessionRef) => {
				state = syncTasks(state);
				state.tasks[taskId] = { ...state.tasks[taskId], piSessionRef };
				await checkpoint();
			} });
    const taskRecovery=resumeState ? await recoveryTaskArtifacts(options.cwd,resumeState.runId) : undefined;
    const runner = cfg.workspace.taskIsolation ? isolateTaskWorkspaces({repoPath:options.cwd,integrationPath:workspace.path,runDir:trace.dir,runner:baseRunner,cleanup:cfg.workspace.cleanup,resumeArtifacts:taskRecovery,onWorkspace:async ref=>{state=recordWorkspace(state,ref);await checkpoint();}}) : baseRunner;
    const generatedPlanner=options.planner ?? (analysis.complexity==="small"&&analysis.risk==="low"?createHeuristicPlanner():planningWith(cfg,options.cwd,contextPack.text,reason=>{plannerFallback=reason;trace.emit({type:"replan.triggered",reason:`planner fallback: ${reason}`});},{...agentConfig,signal:options.signal},trace));
		const result = await runSakuraTask(
			{ task: options.task, hintFiles: options.files },
			{
				replanner: createReplanner(),
				signal: options.signal,
				onGraph: checkpoint,
        beforeWave: async graph => {runBudget.check();await instructions.boundary(graph); await checkpoint(graph);},
				onPlan: async (graph) => {
					if (Object.keys(graph.nodes).length > cfg.planning.maxTasks) throw new Error("Plan exceeds planning.maxTasks");
					if (!suppliedPlan) graph.id = `plan-${runId}`;
					if (!suppliedPlan) planPath = (await savePlan(options.cwd, graph, false)).path;
					state.phase = "running";
					state.planPath = planPath;
					await checkpoint(graph);
					trace.emit({ type: "run.phase", phase: "running", runId });
				},
				planner: suppliedPlan ? {plan:async()=>structuredClone(suppliedPlan)} : {plan:async input=>{const graph=await generatedPlanner.plan(input);return options.plannerTransform?options.plannerTransform(graph):graph;}},
				runTask: asTaskRunner(runner, {
					workspacePath: workspace.path,
					context: contextPack.text,
					timeoutMs: cfg.runtime.taskTimeoutMs,
					signal: options.signal,
					baseCommit: workspace.baseCommit,
				}),
				verify: async () => {
					state.phase = "verifying";
					await checkpoint();
					trace.emit({ type: "run.phase", phase: "verifying", runId });
					return verifyWorkspace(cfg, workspace.path, options.signal, options.agentConfig?.approve,protectedChecks);
				},
				trace,
				maxConcurrency: cfg.runtime.maxConcurrency,
				maxReplans: cfg.planning.maxReplans,
			},
		);

		const changes = await workspace.collectChanges();
		diff = changes.diff;
		artifactPath = await saveArtifact(join(trace.dir, "diffs"), runId, changes);
		artifactSaved = true;
		await workspace.close(cfg.workspace.cleanup);
		if (cfg.workspace.cleanup && workspace.path !== options.cwd) trace.emit({ type: "workspace.cleaned", path: workspace.path });

		const experienceIds = await recordExperience(cfg, options.cwd, result,runId,trace.dir,[...usedTools]);

		// §10：结构化状态落盘。不把 DAG / worktree / 证据塞进聊天消息
		state.graph = result.graph;
		state = recordWorkspace(state, {
			taskId: runId,
			path: workspace.path,
			baseCommit: workspace.baseCommit,
			branch: workspace.branch,
			fallbackReason: workspace.warning,
		});
		if (result.verification) state = recordVerification(state, result.verification);
		state = recordExperienceCandidates(state, experienceIds);
		state = syncTasks({ ...state, selectedSkills: skills.map((route) => route.skill.name) });
		state.artifactPath = artifactPath;
		state.endedAt = Date.now();
		state.phase = options.signal?.aborted ? "cancelled" : result.completed ? "ready_to_apply" : result.verification?.status === "not_run" ? "unverified" : "failed";
		await checkpoint();

		trace.emit({ type: "run.phase", phase: state.phase, runId });
		await instructions.close(options.signal?.aborted ? "Run cancelled" : "Run ended");
		const metrics = await trace.finish();
		if(protectedSkills)await recordTrustedRun(options.cwd,{runDir:await realpath(trace.dir),runId,task:options.task,baseCommit:workspace.baseCommit,model:usedModels.size===1?[...usedModels][0]:"unresolved",settingsSha256:digest(JSON.stringify({config:cfg,model:options.agentConfig?.model??[...usedModels].sort(),thinking:options.agentConfig?.thinkingLevel??"off"})),stateSha256:digest(await readFile(join(trace.dir,"state.json"),"utf8")),packSha256:digest(await readFile(join(trace.dir,"context-pack.json"),"utf8")),skills:state.skillEvidence??[],verified:result.completed&&result.verification?.passed===true,protectedExecution:protectedSandboxSupported()&&!options.runner&&!options.agentConfig?.customTools?.length,metrics:{...metrics}},options.skillAuthority);
		return {
			runId,
			traceDir: trace.dir,
			statePath,
			planPath,
			executionStatus: options.signal?.aborted ? "cancelled" : Object.values(result.graph.nodes).every((node) => node.status === "succeeded") ? "succeeded" : "failed",
			checkStatus: options.signal?.aborted ? "cancelled" : result.verification?.status ?? (result.verification ? result.verification.passed ? "passed" : "failed" : "not_run"),
			applyStatus: "pending",
			artifactPath,
			workspacePath: workspace.path,
			completed: result.completed,
			result,
			metrics,
			experiences: experienceIds.length,
			diff,
			skills,
			plannerFallback,
			warning: workspace.warning,
		};
	} catch (error) {
		let recoveryWarning: string | undefined;
		if (!artifactSaved) {
			try {
				const changes = await workspace.collectChanges();
				diff = changes.diff;
				artifactPath = await saveArtifact(join(trace.dir, "diffs"), runId, changes);
				artifactSaved = true;
			} catch (saveError) {
				recoveryWarning = `产物保存失败，保留工作区 ${workspace.path}: ${saveError instanceof Error ? saveError.message : String(saveError)}`;
			}
		}
		if (artifactSaved) {
			await workspace.close(cfg.workspace.cleanup).catch((cleanupError) => {
				recoveryWarning = `工作区清理失败，保留 ${workspace.path}: ${String(cleanupError)}`;
			});
		}
		state.phase = options.signal?.aborted ? "cancelled" : "failed";
    state.error = error instanceof Error ? error.message : String(error);
    state.artifactPath = artifactPath;
    state.endedAt = Date.now();
    await checkpoint().catch((error) => { recoveryWarning = [recoveryWarning, `检查点保存失败: ${String(error)}`].filter(Boolean).join("\n"); });
    trace.emit({ type: "run.phase", phase: state.phase, runId });
		await instructions.close(options.signal?.aborted ? "Run cancelled" : "Run failed").catch(error => {recoveryWarning = [recoveryWarning,String(error)].filter(Boolean).join("\n");});
		const metrics = await trace.finish().catch(() => emptyMetrics(runId, Date.now()));
		return {
			runId,
			traceDir: trace.dir,
			completed: false,
			metrics,
			experiences: 0,
			diff,
			artifactPath,
			workspacePath: workspace.path,
			skills,
			plannerFallback,
			warning: [workspace.warning, recoveryWarning].filter(Boolean).join("\n") || undefined,
			planPath,
			statePath,
			executionStatus: options.signal?.aborted ? "cancelled" : "failed",
			checkStatus: "not_run",
			applyStatus: "pending",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** §9.2 Skill Router：目录不存在就返回空，不报错。 */
async function selectSkills(options: RunOptions, analysis: TaskAnalysis): Promise<SkillRoute[]> {
	const dirs = [...(options.skillDirs ?? []), join(options.cwd, "skills")];
	const catalog = await loadSkillCatalog(dirs);
  const formal=await loadSkillCatalog([join(options.cwd,".pi","skills")]);
  {
    const active=await existingActiveSkills(options.cwd,options.skillAuthority);
    for(const skill of formal.filter(skill=>skill.name.startsWith("sakura-learned-"))){const path=await realpath(skill.path);const record=active.find(item=>item.name===skill.name&&item.path===path);if(!record)throw new Error("Formal learned skill has no trusted active ownership");skill.path=path;skill.artifactSha256=record.sha256;}
  }
  catalog.push(...formal);
	if (!catalog.length) return [];
  // An explicitly replayed revision wins over an older active revision with the same name.
  const seen=new Set<string>(),unique=catalog.filter(skill=>{if(seen.has(skill.name))return false;seen.add(skill.name);return true;});
	return routeSkills(unique, { task: options.task, analysis, limit: 3 });
}

/**
 * 规划时就校验：非法图在执行前就报，而不是跑一半才炸。
 *
 * §8.1：优先用 Pi Session + `submit_plan` 的结构化 Planner；只有它失败时才回落到
 * 确定性 Planner，并把原因交给 onFallback（进 trace）。静默降级会让 Benchmark 误判。
 */
function planningWith(cfg: SakuraConfig, cwd: string, skillReferences: string, onFallback: (reason: string) => void, agentConfig?: Partial<SakuraAgentConfig>, trace?:RunTrace): Planner {
	// localOnly 必须从这里传下去：不传的话 Planner 会用写死的本地 Ollama，
	// 而 sakura.config.yaml 里写的 localOnly: false 只对 AgentRunner 生效——
	// 表现是“每次规划都降级到启发式”，原因还指向 submit_plan，非常难查。实测踩到过。
	const resilient = createResilientPlanner({
		trace, cwd, onFallback, config: { localOnly: cfg.runtime.localOnly, ...agentConfig } });
	const heuristic = createHeuristicPlanner();

	return {
		async plan(input: PlannerInput) {
			const experience: string[] = []; // Already selected, sourced and budgeted in the Context Pack.
			const enriched: PlannerInput = {
				...input,
				experience,
				repoContext: [input.repoContext, skillReferences].filter(Boolean).join("\n\n"),
			};
			const graph = await resilient.plan(enriched);
			const errors = validateGraph(graph);
			if (errors.length) {
				// 模型给了不合法的图（例如成环）→ 用启发式兜底，但仍然报出来
				onFallback(`model plan failed graph validation: ${errors.join("; ")}`);
				const fallbackGraph = await heuristic.plan(enriched);
				const fallbackErrors = validateGraph(fallbackGraph);
				if (fallbackErrors.length) throw new Error(`任务图不合法，拒绝执行:\n${fallbackErrors.join("\n")}`);
				return fallbackGraph;
			}
			return graph;
		},
	};
}

/** 用项目自己的命令，不发明命令（架构路线 §13）。 */
async function verifyWorkspace(cfg: SakuraConfig, path: string, signal?: AbortSignal, approve?: Approval,protection?:Parameters<typeof createShellCommandRunner>[0]): Promise<VerificationResult> {
	const plan = await detectVerificationPlan(path);
	return verify({
		cwd: path,
		signal,
		commands: cfg.verification.commands ?? toCommandSequence(plan),
		run: async (command, cwd, signal) => {
      const policy = { workspacePath: cwd, network: cfg.policy.network, gitPush: cfg.policy.gitPush,externalWrite:cfg.policy.externalWrite };
      // Repository-defined verification is still executable code; unattended approval cannot be assumed.
      const decision = await enforceAction(policy, {agentId:"verification",tool:"verification",kind:"exec",command}, approve);
      if (decision.type !== "allow") return {exitCode:1,stdout:"",stderr:decision.reason};
      return createShellCommandRunner(protection)(command,cwd,signal);
    },
		reviewDiff: cfg.verification.requireDiffReview ? createDiffReviewer() : undefined,
	});
}

/** 只有跑出证据的 run 才进经验库；模型不许自动改正式 Skill（架构路线 §15）。 */
async function recordExperience(cfg: SakuraConfig, cwd: string, result: OrchestratorResult,runId:string,traceDir:string,usedTools:string[]): Promise<string[]> {
	if (!cfg.experience.enabled) return [];
	const store = createExperienceStore(cwd);
	const extracted = createExperienceExtractor().extract({
		graph: result.graph,
    runId,traceDir,usedTools,
		verification: result.verification,
		successfulActions: [],
		failedAttempts: [],
	});
	const ids:string[]=[];
	for (const experience of extracted) ids.push(await store.add(experience));
	return ids;
}

interface OpenWorkspace {
	path: string;
	baseCommit?: string;
	branch?: string;
	warning?: string;
	collectChanges(): Promise<WorkspaceChanges>;
	close(cleanup: boolean): Promise<void>;
}

async function openWorkspace(cfg: SakuraConfig, cwd: string, runId: string): Promise<OpenWorkspace> {
	if (cfg.workspace.mode === "in-place") {
		return { path: cwd, collectChanges: () => captureChanges(cwd), close: async () => undefined };
	}

	const manager: WorkspaceManager = createWorkspaceManager({ repoPath: cwd, rootDir: join(cwd, ".sakura", "worktrees") });
	try {
		const session = await manager.createWorkspace(runId);
		return {
			path: session.worktreePath,
			baseCommit: session.baseCommit,
			branch: session.branch,
			collectChanges: async () => {
				await manager.collectDiff(session);
				if (!session.artifact) throw new Error("Workspace snapshot was not collected");
				return session.artifact;
			},
			close: async (cleanup) => {
				if (cleanup) await manager.cleanup(session);
			},
		};
	} catch (error) {
    throw new Error(`Worktree isolation unavailable; use explicit workspace.mode: in-place only when intended. ${String(error)}`);
  }
}

/** 所有数字都来自 trace/metrics，没有一个是渲染层编的（架构路线 §26）。 */
export function renderReport(outcome: RunOutcome): string {
	const lines = [`# Sakura Run ${outcome.runId}`, `execution: ${outcome.executionStatus ?? "unknown"}  checks: ${outcome.checkStatus ?? "not_run"}  application: ${outcome.applyStatus ?? "pending"}`];
	if (outcome.planPath) lines.push(`plan: ${outcome.planPath}`);
	if (outcome.artifactPath) lines.push(`artifact: ${outcome.artifactPath}`);
	if (outcome.warning) lines.push(`⚠ ${outcome.warning}`);
	if (outcome.plannerFallback) lines.push(`⚠ planner 降级到启发式：${outcome.plannerFallback}`);
	if (outcome.skills.length) lines.push(`skills: ${outcome.skills.map((route) => `${route.skill.name} (${route.reason})`).join(" | ")}`);
	if (outcome.error) lines.push("", "run failed before completion:", outcome.error, "", `trace: ${outcome.traceDir}`);
	if (!outcome.result) return lines.join("\n");

	const { result, metrics } = outcome;
	const nodes = Object.values(result.graph.nodes);
	const failed = nodes.filter((node) => node.status !== "succeeded");
	lines.push(
		"",
		"[PLAN]",
		`tasks: ${nodes.length}  complexity: ${result.analysis.complexity}  risk: ${result.analysis.risk}`,
		"",
		"[RUN]",
		...nodes.map((node) => `- ${node.id} (${node.role}) → ${node.status}`),
		"",
		"[VERIFY]",
		result.verification?.steps.length
			? result.verification.steps.map((step) => `- ${step.exitCode === 0 ? "✓" : "✗"} ${step.command} (${step.durationMs}ms)`).join("\n")
			: "- 没有可探测的验证命令",
		"",
		"[RESULT]",
		`completed: ${result.completed}`,
		`agents: ${metrics.agents}  tool calls: ${metrics.toolCalls}  replans: ${metrics.replans}`,
		`tokens: ${metrics.tokensIn ?? "unknown"} in / ${metrics.tokensOut ?? "unknown"} out`,
		`verification: ${metrics.verificationPassed}/${metrics.verificationRuns} passed`,
		`failed tasks: ${failed.length ? failed.map((node) => `${node.id}: ${node.result?.summary ?? "unknown"}`).join(" | ") : "none"}`,
		`experience recorded: ${outcome.experiences}`,
		outcome.statePath ? `state: ${outcome.statePath}` : "",
		outcome.diff
			? `diff: ${outcome.diff.split("\n").length} lines → ${join(outcome.traceDir, "diffs", `${outcome.runId}.diff`)}（不自动合并，留给人 review）`
			: "diff: 无改动",
	);
	return lines.filter(Boolean).join("\n");
}

/** Recovery materializes the saved snapshot only in the new isolated workspace. */
async function restoreArtifact(cwd: string, path: string): Promise<void> {
  const { artifact, patchPath, patch } = await readArtifact(path);
  const existing = await captureChanges(cwd, artifact.baseCommit);
  if (existing.diff) throw new Error("Recovery workspace is not clean; refusing to overwrite changes");
  if (!patch) return;
  const exec = promisify(execFile);
  await exec("git", ["apply", "--check", "--binary", patchPath], { cwd });
  await exec("git", ["apply", "--binary", patchPath], { cwd });
}

async function recoveryTaskArtifacts(cwd:string,runId:string):Promise<Record<string,string>> {
  const dir=join(cwd,".sakura","runs",runId,"integrations");
  let names:string[];try{names=await readdir(dir);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT") return {};throw error;}
  const records=await Promise.all(names.filter(name=>name.endsWith(".json")).map(async name=>JSON.parse(await readFile(join(dir,name),"utf8")) as import("./workspace/task-workspaces.ts").IntegrationRecord));
  return Object.fromEntries(records.filter(record=>record.status==="failed" && record.artifactPath).sort((a,b)=>a.createdAt-b.createdAt).map(record=>[record.taskId,record.artifactPath!]));
}
