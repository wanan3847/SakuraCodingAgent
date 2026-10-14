/**
 * 最小可用的 Pi 插件。
 *
 * 三条硬规则（踩了就没提示，或者干脆起不来）：
 *   1. **必须有 `export default function`**。Pi 用 jiti.import(path, { default: true })，拿到的
 *      不是函数就报 "does not export a valid factory function"，然后 pi 直接 exit 1。
 *   2. 这个函数可以是 async（工厂里 await 初始化没问题）。
 *   3. 别把没有 default export 的辅助文件放在 extensions/ 里——它会被当成插件加载并失败。
 *      共享代码放包内其它目录，或者放同目录的子文件夹（子文件夹只有 index.ts 会被加载）。
 */

// 只 import 类型（运行时由 Pi 注入 api 对象）。类型来自 devDependency 里的真包。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function example(pi: ExtensionAPI): void {
	// ---- 1. 注册一个 LLM 可调用的工具 ----
	pi.registerTool({
		name: "example_greet",
		label: "Example Greet",
		description: "Greet someone by name. Use when the user asks for a greeting.",
		// promptSnippet 是让它出现在系统提示 "Available tools" 里的开关；
		// 不给也能被调用（schema 照样发给模型），但模型更容易忽略它。
		promptSnippet: "Greet someone by name",
		promptGuidelines: [
			"Use example_greet when the user explicitly asks for a greeting; do not use it for anything else.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Who to greet" }),
			loud: Type.Optional(Type.Boolean({ description: "Uppercase the greeting" })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx: ExtensionContext) {
			// 长任务可以中途回报。注意 onUpdate 的实参类型是完整的 AgentToolResult：
			// details 是**必填**的，只给 content 会被类型检查拦下（照着手写声明写就会踩）。
			onUpdate?.({ content: [{ type: "text", text: "working…" }], details: {} });
			const text = `Hello, ${params.name}! (cwd: ${ctx.cwd})`;
			return { content: [{ type: "text", text: params.loud ? text.toUpperCase() : text }], details: {} };
		},
	});

	// ---- 2. 注册斜杠命令 ----
	// 注意命名空间冲突：扩展命令 / 技能 / prompt 模板共用同一个斜杠命名空间，
	// 优先级是 扩展命令 > /skill:<name> > /<模板名>。同名时扩展命令会**默默吃掉**输入，
	// 另外两个永远不会被执行。实测踩到过（三者都叫 example，/example 只剩扩展命令生效）。
	// 所以：命令用动词（/hello），prompt 模板带后缀（/example-task），技能带 -skill。
	pi.registerCommand("hello", {
		description: "Show the example plugin status: /hello [args]",
		// ctx 是 ExtensionCommandContext，比事件里的 ExtensionContext 多 ui.select 等交互能力
		async handler(args, ctx) {
			// hasUI 在 print/json 模式下是 false：交互 API 会挂，先判断
			if (!ctx.hasUI) return;
			ctx.ui.notify(`example plugin alive; args=${args || "(none)"} mode=${ctx.mode}`, "info");
		},
	});

	// ---- 3. 拦截工具调用（权限门、路径保护、参数改写）----
	pi.on("tool_call", async (event, ctx) => {
		// 只想处理 bash 时用 isToolCallEventType（能拿到 event.input 的精确类型）
		if (event.toolName !== "bash") return undefined;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!/^git\s+push/.test(command)) return undefined;

		// 无 UI 时不能假装问过了，直接拦住
		if (!ctx.hasUI) return { block: true, reason: "git push needs approval but no UI is available" };
		const ok = await ctx.ui.confirm("Allow push?", command);
		return ok ? undefined : { block: true, reason: "rejected by user" };
		// 想改参数就原地改 event.input（改了不会再做 schema 校验）
	});

	// ---- 4. 启动时打点，确认插件真的加载了 ----
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.notify("example plugin loaded", "info");
	});
}
