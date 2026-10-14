/**
 * 合同测试：官方 Pi SDK能不能真的起一个 AgentSession。
 *
 * 这是复用指南 §11.2 那套合同测试的最小可跑版本，不调模型、不需要 API key：
 * 验证公开导出、角色白名单与 SDK 接线，保护上游升级。
 * 接模型的那部分在 tests/e2e（需要凭证）。
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createSakuraAgent as createAgent } from "../../src/runtime/create-agent.ts";
import { configForRole } from "../../src/runtime/agent-config.ts";
import { agentProfile } from "../../src/orchestrator/agent-registry.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager, ModelRuntime } from "@earendil-works/pi-coding-agent";

// Native Pi configuration, isolated from user credentials and catalogs.
let fixtureDir: string;
let modelRuntime: ModelRuntime;
let settingsManager: SettingsManager;
before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "sakura-model-config-"));
  await writeFile(join(fixtureDir, "models.json"), JSON.stringify({ providers: { local: {
    baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "local-test",
    models: [{ id: "fixture-coder", reasoning: false, contextWindow: 4096, maxTokens: 512 }],
  } } }));
  modelRuntime = await ModelRuntime.create({ authPath: join(fixtureDir, "auth.json"), modelsPath: join(fixtureDir, "models.json"), modelsStorePath: join(fixtureDir, "models-store.json"), allowModelNetwork: false });
  settingsManager = SettingsManager.inMemory({ defaultProvider: "local", defaultModel: "fixture-coder" });
});
after(() => rm(fixtureDir, { recursive: true, force: true }));
function createSakuraAgent(config: Parameters<typeof createAgent>[0]) {
  return createAgent({ agentDir: fixtureDir, modelRuntime, settingsManager, ...config });
}

test("official Pi SDK exposes the runtime entry points we depend on", async () => {
	const core = await import("@earendil-works/pi-coding-agent");
	assert.equal(typeof core.createAgentSession, "function");
	assert.equal(typeof core.SessionManager, "function");
	assert.equal(typeof core.createCodingTools, "function");
	assert.equal(typeof core.SessionManager.inMemory, "function");
});

test("runtime glue creates a headless read-only agent session with the role's tool allowlist", async () => {
	const config = configForRole("explorer", process.cwd(), { sessionMode: "memory" });
	assert.deepEqual(config.allowedTools, agentProfile("explorer").allowedTools);
	assert.equal(agentProfile("explorer").writes, false);

	const agent = await createSakuraAgent(config);
	try {
		assert.equal(typeof agent.session.prompt, "function");
		assert.equal(typeof agent.session.abort, "function");
		assert.ok(agent.session.sessionId);
	} finally {
		agent.dispose();
	}
});

test("runtime uses native Pi model configuration without a hardcoded model", async () => {
  const agent = await createSakuraAgent(configForRole("explorer", process.cwd(), { sessionMode: "memory" }));
  try {
    assert.equal(agent.session.model?.provider, "local");
    assert.equal(agent.session.model?.id, "fixture-coder");
    assert.equal(agent.session.model?.contextWindow, 4096);
  } finally { agent.dispose(); }
});

test("runtime glue rejects cloud models in local-only mode", async () => {
	await assert.rejects(
		() =>
			createSakuraAgent(
				configForRole("explorer", process.cwd(), {
					sessionMode: "memory",
					model: {
						id: "cloud-model",
						name: "Cloud model",
						api: "openai-completions",
						provider: "deepseek",
						baseUrl: "https://example.invalid/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 4096,
						maxTokens: 512,
					},
				}),
			),
		/local-only mode rejects/,
	);
});

test("runtime glue rejects an Ollama model pointed at a remote endpoint", async () => {
	await assert.rejects(
		() =>
			createSakuraAgent(
				configForRole("explorer", process.cwd(), {
					sessionMode: "memory",
					model: {
						id: "qwen3.5:4b",
						name: "Remote Ollama",
						api: "openai-completions",
						provider: "ollama",
						baseUrl: "https://example.invalid/v1",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 262144,
						maxTokens: 32768,
					},
				}),
			),
		/local-only mode rejects/,
	);
});

test("runtime glue can restore an explicit cloud model when local-only mode is disabled", async () => {
	const agent = await createSakuraAgent(
		configForRole("explorer", process.cwd(), {
			sessionMode: "memory",
			localOnly: false,
			model: {
				id: "cloud-model",
				name: "Cloud model",
				api: "openai-completions",
				provider: "deepseek",
				baseUrl: "https://example.invalid/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 512,
			},
		}),
	);
	try {
		assert.ok(agent.session.model);
		assert.equal(agent.session.model.provider, "deepseek");
	} finally {
		agent.dispose();
	}
});

/**
 * 合同测试：`customTools` 和 `tools` 白名单的关系。
 *
 * Pi 的 `tools` 是统一白名单，空数组 `[]` 会把 customTools 一起挡掉——不测这一条，
 * 表现是「Planner 每次都静默降级到启发式」，而不是报错。实测踩到过。
 */
test("customTools are only active when the tools allowlist includes them", async () => {
	const { createSubmitPlanTool } = await import("../../src/runtime/plan-agent.ts");
	const { tool } = createSubmitPlanTool();

	const blocked = await createSakuraAgent({
		role: "planner",
		cwd: process.cwd(),
		allowedTools: [],
		customTools: [tool],
		sessionMode: "memory",
	});
	try {
		assert.deepEqual(blocked.session.getActiveToolNames(), [], "空白名单必须把所有工具（含 customTools）挡掉");
		assert.equal(blocked.session.getToolDefinition("submit_plan"), undefined);
	} finally {
		blocked.dispose();
	}

	const allowed = await createSakuraAgent({
		role: "planner",
		cwd: process.cwd(),
		allowedTools: ["submit_plan"],
		customTools: [tool],
		sessionMode: "memory",
	});
	try {
		assert.deepEqual(allowed.session.getActiveToolNames(), ["submit_plan"], "白名单里点名才生效，且不带内置工具");
		assert.ok(allowed.session.getToolDefinition("submit_plan"), "Planner 必须真的拿到 submit_plan");
	} finally {
		allowed.dispose();
	}
});

test("child sessions ignore executable global extensions and inject the role into the real system prompt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sakura-role-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "unexpected.ts"), 'throw new Error("unexpected extension executed");');
  const agent = await createSakuraAgent({ role: "explorer", cwd: directory, agentDir, sessionMode: "memory", systemPrompt: "ROLE_CONTRACT_MARKER" });
  try {
    assert.ok(agent.session.systemPrompt.includes("ROLE_CONTRACT_MARKER"));
    assert.deepEqual(agent.session.getActiveToolNames(), agentProfile("explorer").allowedTools);
    assert.equal(agent.session.getAllTools().some((tool) => tool.name.startsWith("sakura_") || tool.name.startsWith("mcp__")), false);
  } finally { agent.dispose(); }
});

test("read-only roles cannot enable arbitrary shell or write tools through config overrides", async () => {
  for (const tool of ["write", "edit", "bash", "powershell", "*", "+bash", "unknown"] ) {
    await assert.rejects(createSakuraAgent({ role: "reviewer", cwd: process.cwd(), allowedTools: [tool] }), /Read-only role/);
  }
});

test("official Pi resource loading registers the Sakura package tools and commands", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sakura-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageRoot = new URL("../../", import.meta.url).pathname;
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: join(directory, "agent"), settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
    noSkills: true, noPromptTemplates: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const tools = result.extensions.flatMap((extension) => [...extension.tools.keys()]).sort();
  assert.deepEqual(tools, ["sakura_delegate", "sakura_experience", "sakura_plan", "sakura_repo", "sakura_run", "sakura_workspace"]);
  const commands = result.extensions.flatMap((extension) => [...extension.commands.keys()]);
  assert.ok(commands.includes("sakura-run"));
  assert.ok(commands.includes("sakura-subagent"));
  const orchestrator = result.extensions.find(extension => extension.commands.has("sakura-run"))!;
  assert.equal(orchestrator.commands.get("sakura-subagent")!.handler, orchestrator.commands.get("sakura-run")!.handler);
  assert.ok(commands.includes("sakura-status"));
  // Sakura keeps model switching on Pi's native /model; registering it here would shadow that selector.
  assert.ok(!commands.includes("model"), "Sakura must not register a /model command");
  const { themes, diagnostics } = loader.getThemes();
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(themes.map((theme) => theme.name).sort(), ["sakura-light", "sakura-night"]);
  for (const theme of themes) {
    assert.ok(theme.fg("error", "失败").includes("失败"));
    assert.ok(theme.fg("toolDiffAdded", "+ 新增").includes("+ 新增"));
  }
});
