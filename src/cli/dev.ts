/**
 * Sakura CLI（架构路线 §26）。和 5 个扩展共用 src/ 里同一套内核，不另写一份逻辑。
 *
 *   sakura plan "<task>" [--files a.ts,b.ts]   # 只规划：不需要模型，不烧 token
 *   sakura repo <action> [target]              # 仓库图查询
 *   sakura experience [query]                  # 经验库检索
 *   sakura status                              # 最近一次 run 的 metrics
 *   sakura verify [dir]                        # 只跑验证命令（不调模型）
 *   sakura run "<task>"                        # 完整闭环（需要模型）
 *
 * 默认 localOnly=true，只允许本地 Ollama；要云端模型在 sakura.config.yaml 里显式关掉。
 */

import {readFile} from "node:fs/promises";
import {clusterExperience} from "../experience/patterns.ts";
import {undoCheckpoint} from '../workspace/apply-artifact.ts';
import {resolveCheckpoint} from '../workspace/code-checkpoint.ts';
import {proposeCandidate,evaluateCandidate,reviewCandidate,promoteCandidate,rollbackCandidate,loadCandidate,loadActiveSkill,assessCandidateEffect} from "../experience/skill-candidates.ts";
import { join } from "node:path";
import {
	analyzeTask,
	enqueueRunInstruction,
	applyArtifact,
	readArtifact,
	savePlan,
	loadPlan,
	loadRunState,
	listRuns,
	createDiffReviewer,
	createExperienceStore,
	createHeuristicPlanner,
	createVerificationCommandRunner,
	createRepositoryParser,
	delegateTasks,
	detectVerificationPlan,
	experienceContext,
	analyzeImpact,
	formatImpact,
	indexRepository,
	loadConfig,
	loadSkillCatalog,
	newestRunMetrics,
	renderDelegation,
	renderReport,
	retrieveExperience,
	routeSkills,
	runSakuraTaskOnce,
	toCommandSequence,
	topoLayers,
	validateGraph,
	verify,
} from "../index.ts";

const USAGE = `sakura <command> [args]

  plan "<task>" [--files a.ts,b.ts]   只规划 Task DAG（不需要模型）
  repo <action> [target]             index|symbol|references|dependencies|tests|impact|search
  experience [query]                 经验库检索
  candidate <action> [args]           propose|evaluate|assess|review|promote|rollback|show|active
  status                             最近一次 run 的 metrics
  instruct <runId> <taskId> <mode> "text"   steer|follow-up|plan 定向补充
  history                            历史运行
  resume <runId>                     恢复未完成节点
  verify [dir]                       只跑验证命令（不需要模型）
  run "<task>" | --plan <path>        执行新任务或保存的计划（需要模型）
  diff <artifact.json>               预览保存产物
  apply <artifact.json> [--files a,b] 接受全部或选定文件并复验\n  undo <checkpoint.json>             安全撤销已接受的代码检查点
  delegate "a" ; "b" ; "c"           并行委托互相独立的子任务（需要模型）

--files 逗号分隔；--json 输出 JSON；--help 看这份说明。`;

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	const json = rest.includes("--json");
	const controlIndex=rest.indexOf("--control-dir");
	const authority=controlIndex>=0?{controlDir:rest[controlIndex+1]}:{};
	if(controlIndex>=0&&!authority.controlDir)return fail("--control-dir requires an external trusted directory");
	const args = rest.filter((arg,index) => arg !== "--json"&&(controlIndex<0||(index!==controlIndex&&index!==controlIndex+1)));
	const filesFlag = args.findIndex((arg) => arg === "--files");
	const files = filesFlag >= 0 ? (args[filesFlag + 1] ?? "").split(",").filter(Boolean) : undefined;
	// 没有 --files 时不能过滤，否则会把第一个位置参数（子命令动作）吃掉
	const positional = filesFlag >= 0 ? args.filter((_, index) => index !== filesFlag && index !== filesFlag + 1) : args;
	const cwd = process.cwd();

	switch (command) {
		case "plan": {
			const task = positional.join(" ").trim();
			if (!task) return fail("plan 需要一个任务描述");
			const analysis = analyzeTask({ description: task, hintFiles: files });
			const saved = await savePlan(cwd, await createHeuristicPlanner().plan({ task, analysis }));
			const graph = saved.graph;
			const errors = validateGraph(graph);
			const catalog = await loadSkillCatalog([new URL("../../skills/", import.meta.url).pathname, join(cwd, "skills")]);
			const skills = routeSkills(catalog, { task, analysis, limit: 3 });
			if (json) return out(JSON.stringify({ analysis, graph, planPath: saved.path, planner: "heuristic", errors, skills: skills.map((r) => r.skill.name) }, null, 2));
			const experience = await experienceContext(createExperienceStore(cwd), task);
			return out(
				[
					`plan: ${graph.id} v${graph.version} (heuristic)\nsaved: ${saved.path}`,
					`analysis: ${JSON.stringify(analysis)}`,
					experience.length ? `experience:\n${experience.map((line) => `  - ${line}`).join("\n")}` : "experience: (none)",
					skills.length ? `skills: ${skills.map((route) => `${route.skill.name} (${route.reason})`).join(" | ")}` : "skills: (none routed)",
					"layers:",
					...topoLayers(graph).map((layer, index) => `  ${index + 1}. ${layer.join(", ")}`),
					errors.length ? `INVALID:\n${errors.join("\n")}` : "graph valid.",
				].join("\n"),
			);
		}

		case "repo": {
			const [action = "index", ...targetParts] = positional;
			const target = targetParts.join(" ");
			const { index, indexedFiles, skipped, coverage, unresolvedCalls, parsedFiles, reusedFiles } = await indexRepository({ root: cwd, parser: createRepositoryParser() });
			// 符号级查询统一先解析回文件：第一版的 IMPORTS / TESTS 边是文件级的，
			// 直接拿 symbolId 查会静默返回 []，看起来像“没有依赖”，比报错更危险。
			const impact = target ? analyzeImpact(index, target) : undefined;
			const id = index.findSymbol(target)[0]?.id ?? target;

			const result: Record<string, unknown> = { action, indexedFiles, skipped: skipped.length, coverage, unresolvedCalls, parsedFiles, reusedFiles };
			if (action === "index") result.size = index.size();
			if (action === "symbol") result.symbols = index.findSymbol(target);
			if (action === "references") result.references = index.findReferences(id);
			if (action === "dependencies") result.dependencies = [...new Set((impact?.files ?? []).flatMap((file) => index.getDependencies(file)))];
			if (action === "tests") result.tests = impact?.relatedTests ?? index.findRelatedTests(target);
			if (action === "impact") result.impact = impact;
			if (action === "search") result.matches = index.searchSymbols(target);
			const rendered =
				action === "impact" && impact ? formatImpact(impact) : JSON.stringify(result, null, 2);
			return out(json ? JSON.stringify(result, null, 2) : `${action}: ${rendered}`);
		}

    case "candidate": {
      const [action,id,...remaining]=positional;
      if(action==="propose") return out(JSON.stringify(await proposeCandidate(cwd,JSON.parse(await readFile(id,"utf8")),authority),null,2));
      if(action==="evaluate") return out(JSON.stringify(await evaluateCandidate(cwd,id,remaining[0],authority),null,2));
      if(action==="review") {const shaIndex=remaining.indexOf("--sha256");if(!remaining.includes("--approve")||shaIndex<0||!remaining[shaIndex+1]) return fail("Explicit operator review: candidate review <id> <reviewer> --approve --sha256 <artifactHash>");return out(JSON.stringify(await reviewCandidate(cwd,id,remaining[0],true,{...authority,expectedSha256:remaining[shaIndex+1]},remaining.includes("--user-authorized")?"user-authorized":"human"),null,2));}
      if(action==="promote") return out(JSON.stringify(await promoteCandidate(cwd,id,authority),null,2));
      if(action==="rollback") return out(JSON.stringify(await rollbackCandidate(cwd,id,Number(remaining[0]),authority),null,2));
      if(action==="show") return out(JSON.stringify(await loadCandidate(cwd,id,undefined,authority),null,2));
      if(action==="active") return out(JSON.stringify(await loadActiveSkill(cwd,id,authority),null,2));
      if(action==="assess") return out(JSON.stringify(await assessCandidateEffect(cwd,id,JSON.parse(await readFile(remaining[0],"utf8")),authority),null,2));
      return fail("candidate propose <json> | evaluate <id> <runDir> | assess <id> <pairs.json> | review <id> <reviewer> --approve --sha256 <artifactHash> [--user-authorized] | promote <id> | rollback <id> <version> | show <id> | active <name>; use the same --control-dir for every operation");
    }
		case "experience": {
			if(positional[0]==="patterns")return out(JSON.stringify(clusterExperience(await createExperienceStore(cwd).all()),null,2));
			const query = positional.join(" ").trim();
			const store = createExperienceStore(cwd);
			const hits = query ? retrieveExperience(await store.all(), { task: query, limit: 5 }) : (await store.all()).map((experience) => ({ experience, score: 0, matched: [] }));
			if (json) return out(JSON.stringify(hits, null, 2));
			if (!hits.length) return out(query ? "没有匹配的经验。" : "经验库是空的。");
			return out(
				hits
					.map((hit) => `- [${hit.score}] ${hit.experience.problemPattern}\n    failed: ${hit.experience.failedAttempts.join("; ") || "-"}\n    worked: ${hit.experience.successfulActions.join("; ") || "-"}`)
					.join("\n"),
			);
		}

		case "verify": {
			const dir = positional[0] ?? cwd;
			const plan = await detectVerificationPlan(dir);
			const cfg = await loadConfig(dir);
			const commands = cfg.verification.commands ?? toCommandSequence(plan);
			if (!commands.length) return out(`在 ${dir} 没探测到任何验证命令（package.json / Makefile / pyproject.toml / Cargo.toml / go.mod 都没有可用脚本）`);
			const result = await verify({ cwd: dir, commands, run: createVerificationCommandRunner({workspacePath:dir,network:cfg.policy.network,gitPush:cfg.policy.gitPush,externalWrite:cfg.policy.externalWrite}), reviewDiff: createDiffReviewer() });
			out(json ? JSON.stringify(result, null, 2) : formatVerification(result));
			return result.passed ? 0 : 1;
		}

		case "delegate": {
			const descriptions = positional.join(" ").split(";").map((part) => part.trim()).filter(Boolean);
			if (!descriptions.length) return fail("delegate 至少需要一个子任务，用 ; 分隔");
			const cfg = await loadConfig(cwd);
			const outcome = await delegateTasks({
				cwd,
				tasks: descriptions.map((description, index) => ({ id: `task-${index + 1}`, description, role: "implementer" as const })),
				config: { localOnly: cfg.runtime.localOnly },
				maxConcurrency: cfg.runtime.maxConcurrency,
				timeoutMs: cfg.runtime.taskTimeoutMs,
				onProgress: (message) => process.stderr.write(`${message}\n`),
			});
			return out(json ? JSON.stringify(outcome, null, 2) : renderDelegation(outcome));
		}

		case "instruct": {
      const [runId,target,mode,...text] = positional;
      if (!runId || !target || !["steer","follow-up","plan"].includes(mode)) return fail("instruct <runId> <taskId> steer|follow-up|plan <text>");
      return out(JSON.stringify(await enqueueRunInstruction(cwd,runId,{target,mode:mode as "steer"|"follow-up"|"plan",text:text.join(" ")}),null,2));
    }
		case "history": return out(JSON.stringify(await listRuns(cwd), null, 2));
		case "status": {
			const newest = await newestRunMetrics(cwd);
			if (!newest) return out(json ? JSON.stringify({runId:null,checkpoint:null,metrics:null}) : "还没有 Sakura run（.sakura/runs 不存在）");
			const status={runId:newest.id,checkpoint:newest.state,metrics:newest.metrics??null};
			return out(json ? JSON.stringify(status, null, 2) : `# Sakura ${newest.id}\ncheckpoint: ${newest.state?.phase??"unknown"}\n${newest.metrics?JSON.stringify(newest.metrics,null,2):"最终指标尚未生成；检查点表示最后保存的状态，不证明进程仍在运行。"}`);
		}

		case "diff": {
			if (!positional[0]) return fail("diff 需要产物 manifest 路径");
			const artifact = await readArtifact(positional[0]);
			return out(json ? JSON.stringify(artifact, null, 2) : artifact.patch || "无改动");
		}
		case "apply": {
			if (!positional[0]) return fail("apply 需要产物 manifest 路径");
			const result = await applyArtifact(cwd, positional[0],undefined,files);
			out(JSON.stringify(result, null, 2));
			return result.verification.passed ? 0 : 1;
		}
		case 'undo': {return out(JSON.stringify(await undoCheckpoint(cwd,await resolveCheckpoint(cwd,positional[0])),null,2));}
		case "resume":
		case "run": {
			const candidateIndex=positional.indexOf("--candidate");
      const candidate=candidateIndex>=0 ? await loadCandidate(cwd,positional[candidateIndex+1],undefined,authority) : undefined;
      const runArgs=candidateIndex>=0 ? positional.filter((_,index)=>index!==candidateIndex && index!==candidateIndex+1) : positional;
			const planIndex = runArgs.indexOf("--plan");
			const planPath = planIndex >= 0 ? runArgs[planIndex + 1] : undefined;
			const resumeRunId = command === "resume" ? positional[0] : undefined;
			if (resumeRunId && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(resumeRunId)) return fail("Invalid run id");
			const task = resumeRunId ? (await loadRunState(join(cwd, ".sakura", "runs", resumeRunId))).graph.rootTask : planPath ? (await loadPlan(planPath)).rootTask : runArgs.join(" ").trim();
			if (!task) return fail("run 需要一个任务描述");
			const cfg = await loadConfig(cwd);
			if (cfg.runtime.localOnly) process.stderr.write("note: runtime.localOnly=true，只会用 Pi 配置的 loopback 端点（sakura.config.yaml 可关）\n");
			const controller = new AbortController();
			const cancel = () => controller.abort();
			process.once("SIGINT", cancel);
			process.once("SIGTERM", cancel);
			const outcome = await runSakuraTaskOnce({
				signal: controller.signal,
				task,
				planPath,
				resumeRunId,
				files,
				cwd,
					skillDirs: [new URL("../../skills/", import.meta.url).pathname,...(candidate ? [join(cwd,".sakura","skill-candidates",candidate.id,`replay-v${candidate.version}`)] : [])],
					skillAuthority:controlIndex>=0?authority:undefined,
				onProgress: (message) => process.stderr.write(`${message}\n`),
			});
			process.removeListener("SIGINT", cancel);
			process.removeListener("SIGTERM", cancel);
			const ok = out(json ? JSON.stringify(outcome, null, 2) : renderReport(outcome));
			return outcome.completed ? ok : 1;
		}

		case undefined:
		case "--help":
		case "-h":
			return out(USAGE);

		default:
			return fail(`未知命令 "${command}"\n\n${USAGE}`);
	}
}

function formatVerification(result: Awaited<ReturnType<typeof verify>>): string {
	return [
		`passed: ${result.passed}  diff reviewed: ${result.reviewedDiff}`,
		...result.steps.map((step) => `${step.exitCode === 0 ? "✓" : "✗"} ${step.command} (${step.durationMs}ms)`),
		...result.failures.map((failure) => `! ${failure.command}: ${failure.reason}`),
	].join("\n");
}

function out(text: string): number {
	process.stdout.write(`${text}\n`);
	return 0;
}

function fail(text: string): number {
	process.stderr.write(`${text}\n`);
	return 1;
}

process.exitCode = await main(process.argv.slice(2));
