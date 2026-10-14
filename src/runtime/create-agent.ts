import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager, type AgentSession, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { SakuraAgentConfig } from "./agent-config.ts";
import { loadConfig } from "../config.ts";
import { actionForTool, enforceAction } from "../workspace/guard.ts";
import { agentProfile } from "../orchestrator/agent-registry.ts";
import {join} from "node:path";
import {projectInstructions} from './project-instructions.ts';

/** Pi 的自定义工具定义（复用 P 公开 SDK 的 customTools，不自己造 Tool Runtime）。 */
export type PiCustomTool = NonNullable<CreateAgentSessionOptions["customTools"]>[number];

export interface SakuraAgent {
	session: AgentSession;
	dispose(): void;
}

/** A task policy check; model selection and credentials stay in Pi. */
export function isLoopbackEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export async function createSakuraAgent(config: SakuraAgentConfig): Promise<SakuraAgent> {
	config.signal?.throwIfAborted();
	config.budget?.check();
	const profile = agentProfile(config.role);
	const allowedTools = config.allowedTools ?? profile.allowedTools;
	const readOnlyTools = new Set([...profile.allowedTools, ...(config.customTools ?? []).map((tool) => tool.name)]);
	if (!profile.writes && allowedTools.some((name) => !readOnlyTools.has(name))) {
		throw new Error(`Read-only role ${config.role} cannot enable write or shell tools`);
	}
	const localOnly = config.localOnly ?? true;
	const agentDir = config.agentDir ?? getAgentDir();
	const project = await loadConfig(config.cwd);
	const policy = { workspacePath: config.cwd, network: project.policy.network, gitPush: project.policy.gitPush,externalWrite:project.policy.externalWrite,...config.policy };
	const settingsManager = config.settingsManager ?? SettingsManager.create(process.env.SAKURA_STANDALONE==='1'?join(process.env.SAKURA_HOME!, 'settings-scope'):config.cwd, agentDir);

	// Child sessions receive only explicitly registered tools. Global/project extensions
	// must not recursively load Sakura or grant implicit delegation/MCP capabilities.
	const resourceLoader = new DefaultResourceLoader({
		cwd: config.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
    noContextFiles:true,
    agentsFilesOverride:()=>({agentsFiles:projectInstructions(config.cwd,agentDir)}),
    extensionFactories: [(pi) => {
      pi.on("tool_call", async (event) => {
        try{config.budget?.reserveTool();}catch(error){return {block:true,reason:String(error)};}
        const action = actionForTool(event.toolName, event.input, config.cwd, config.role);
        if (!action) return undefined;
        const decision = await enforceAction(policy, action, config.approve);
        config.onEvent?.({ type:"policy.decision", agentId:config.role, tool:event.toolName, decision:decision.type, reason:decision.type === "allow" ? undefined : decision.reason });
        return decision.type === "allow" ? undefined : { block:true, reason:decision.reason };
      });
    }],
		noSkills: true, // Selected skill evidence is already budgeted in the task Context Pack.
		noPromptTemplates: true,
		noThemes: true,
		appendSystemPrompt: [config.systemPrompt ?? profile.systemPrompt],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: config.cwd,
		agentDir: config.agentDir,
		tools: allowedTools,
		resourceLoader,
		model: config.model,
		modelRuntime: config.modelRuntime,
		settingsManager,
		sessionManager: config.sessionManager ?? (config.sessionMode === "memory" ? SessionManager.inMemory(config.cwd) : undefined),
		thinkingLevel: config.thinkingLevel,
		// 结构化输出走 Pi 的 customTools（复用指南 §8.1 的 submit_plan），不自造 Tool Runtime
		customTools: config.customTools,
	});

	if (config.signal?.aborted) { session.dispose(); config.signal.throwIfAborted(); }
	if (!session.model || session.model.provider === "unknown") {
		session.dispose();
		throw new Error("No Pi model available. Configure models.json/auth.json and choose a default with Pi /model.");
	}
	if (localOnly && !isLoopbackEndpoint(session.model.baseUrl)) {
		const name = `${session.model.provider}/${session.model.id}`;
		session.dispose();
		throw new Error(`Sakura local-only mode rejects ${name}: choose a loopback endpoint in Pi models.json; no cloud fallback is permitted.`);
	}
	if(config.budget?.signal.aborted){session.dispose();config.budget.check();}
	const detachBudget=config.budget?.attach(session);
	return { session, dispose: () => {detachBudget?.();session.dispose();} };
}
