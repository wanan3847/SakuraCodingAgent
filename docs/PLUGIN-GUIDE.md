# 基于 Pi 写插件、打包成自己的 Agent

面向「自己写插件」的工作方式。每条结论都在本机 Pi 0.85.1 上跑过，或指向 `pi-core/` 里的源码行，
你可以自己复核。

配套东西：

| 东西 | 用途 |
|---|---|
| `templates/pi-plugin/` | 可直接复制的包骨架（插件 + 技能 + prompt 模板，都已验证能加载） |
| `scripts/check-plugin.mjs` | 静态体检：把「静默失效」和「起不来」的错法在本地挡掉 |
| `docs/DEVELOPMENT.md` | Sakura 内部模块怎么改（跟本文是两件事） |

---

## 0. 三条命令的开发循环

```bash
cp -R <本仓>/templates/pi-plugin my-pi-agent && cd my-pi-agent
npm install

# 三件事：类型 → 体检 → 真加载
npm run typecheck
npm run check          # = node scripts/check-plugin.mjs .

# ① 改一个插件 → 只加载它，调它的工具
pi -e ./extensions/example.ts -t example_greet --no-session -p "call example_greet with name=world"

# ② 改完整个包 → 按 package.json 的 pi manifest 加载（extensions + skills + prompts）
pi -e "$PWD" --tools read --no-session -p "list your available tools, comma separated"

# ③ 装成常驻 agent
pi install "$PWD"        # 写 ~/.pi/agent/settings.json
pi list
```

`pi -e`（= `--extension`）只对本次运行生效、不写 settings，**调试永远用这个**。
`pi install -l` 写 `.pi/settings.json`（跟项目走，可以提交给团队）。

装完你就有自己的 agent：工具、`/命令`、技能、prompt 模板全在一起。想装到别的机器就发这个目录
（或者 `pi install git:github.com/you/repo@v1`）。

---

## 1. 一个插件长什么样

最小可用形态就三件事——注册工具、注册命令、订阅事件。完整可运行版本见
`templates/pi-plugin/extensions/example.ts`。

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function myPlugin(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What it does (this goes to the LLM)",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return { content: [{ type: "text", text: `cwd=${ctx.cwd} path=${params.path}` }], details: {} };
    },
  });

  pi.registerCommand("my-cmd", {
    description: "…",
    async handler(args, ctx) { if (ctx.hasUI) ctx.ui.notify(args, "info"); },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && /^git\s+push/.test(String(event.input.command ?? ""))) {
      return ctx.hasUI && !(await ctx.ui.confirm("push?", String(event.input.command)))
        ? { block: true, reason: "rejected by user" }
        : undefined;
    }
    return undefined;
  });
}
```

### 类型从哪来

```bash
npm i -D @earendil-works/pi-coding-agent typescript @types/node
```

已发布的包（`@earendil-works/pi-coding-agent@0.85.1`）带 `dist/index.d.ts`，里面有
`ExtensionAPI` / `ExtensionContext` / `ToolCallEvent` / `ToolDefinition` /
`isToolCallEventType`。模板里的 `tsconfig.json` 已经配好，`npm run typecheck` 就能用。

**用真类型，不要手写声明。** 实测差别：照手写声明写 `onUpdate?.({ content: […] })` 能过，
但真类型要求 `details` 必填（`AgentToolResult`），
`tsc` 直接报 `Property 'details' is missing`。本仓 `types/pi-extension.d.ts` 那份手写声明
是因为我们删掉了 Pi 源码树又不许先构建，属于本仓的历史包袱，不是给你的推荐做法。

### 你能用到的 API（都在 `ExtensionAPI` 上）

| 分组 | 方法 |
|---|---|
| 事件 | `on(event, handler)` —— 40 个事件，见下 |
| 工具 | `registerTool` / `getActiveTools` / `setActiveTools` / `getAllTools` |
| 命令/快捷键/开关 | `registerCommand` / `registerShortcut` / `registerFlag` / `getFlag` |
| 会话 | `sendMessage` / `sendUserMessage` / `appendEntry` / `setSessionName` / `getSessionName` |
| 模型 | `setModel` / `getModel`(ctx) / `registerProvider` / `setThinkingLevel` |
| 渲染 | `registerMessageRenderer` / `registerEntryRenderer` / `registerMarkdownTransformer` |
| 其它 | `exec` / `getCommands` |

常用事件（完整列表见 `pi-core/coding-agent/core/extensions/types.ts:1252`）：

```
会话：session_start / session_shutdown / session_before_switch / session_before_fork /
      session_before_compact / session_compact / session_before_tree / session_tree
轮次：before_agent_start / agent_start / agent_end / agent_settled / turn_start / turn_end
消息：message_start / message_update / message_end
工具：tool_call（可 block / 可改参数）/ tool_result（可改结果）/
      tool_execution_start / tool_execution_update / tool_execution_end
输入：input（可拦截或改写用户输入）/ user_bash（可换成远程 shell）
模型：model_select / thinking_level_select / before_provider_request /
      before_provider_headers / after_provider_response
上下文：context / resources_discover / project_trust
```

`ExtensionContext` 上你会用到的：`cwd`、`mode`、`hasUI`、`ui`、`sessionManager`、`signal`、
`abort()`、`isIdle()`、`getContextUsage()`、`compact()`、`getSystemPrompt()`、`exec()`。

---

## 1.5 一个包要几个插件？先分清"模块数"和"插件数"

这是最容易懵的地方。两件事没有对应关系：

```
模块 = 问题怎么分解    → 你想拆几个就拆几个，只在 src/ 里，跟 Pi 无关
插件 = Pi 加载什么     → 一个文件 / 一个目录都是一个插件
```

你有 5 个自研模块，插件可以是 1 个、6 个、或者只挑其中两个暴露出来。**都行，取决于你怎么用。**

### 两条路

| | 一个入口 | 一个模块一个文件 |
|---|---|---|
| 文件数 | 1 | N |
| 结构 | 1 个文件，内部逐个调 `registerXxx()`（实现在别处） | 每个文件自带注册，不需要转发层 |
| 少出错 | 少 N-1 分辨手的机会 | 每个文件都要 `export default`，每个都要写进 manifest |
| 冲突面 | 最小 | N 倍：工具名/flag 名全局唯一，撞名 = pi 起不来 |
| `pi config` 逐个开关 | 做不到 | 可以 |

**唯一的实质差别是最后一行。** 想要"这个项目里只开只读的，不开会改代码的"，就必须拆；
不需要这个能力，拆开只是多了手工一致性的负担。

### 拆开**不会**带来故障隔离

最常见的误解。任何扩展加载失败都让 pi **直接退出**，交互模式也一样：

```
Failed to load extension "<path>": <原因>
Hint: Start without extensions using "pi -ne".
                                        ↑ 然后 process.exit(1)
```

所以"拆成 6 个，坏一个只坏一个"是错的——坏一个就全起不来。

### 拆了的话，三件事必须一起做

```jsonc
// 1. 每个文件 export default function (pi) {} —— 不是具名导出
// 2. manifest 逐个列出，别用 ./extensions 全局匹配（以后放辅助文件会被误加载）
"pi": { "extensions": ["./extensions/sakura-repo.ts", "./extensions/sakura-planning.ts"] }
```

```bash
# 3. 本地过一遍。这条命令现在是必需的，不是可选的
npm run check:plugin
```

它检查四类"Pi 只在启动时才告诉你"的问题：

- 哪个文件漏了 `export default`
- manifest 路径不存在 / 值不是 `string[]`（后者会让整份 manifest 被丢弃）
- **跨文件工具名/flag 名重名**（撞名 = `Tool conflict` + `exit 1`）
- import 了没写进 `dependencies` 的包

### 按什么拆

按模块拆是自然的（一个模块一个文件，改起来好找）。但更符合使用习惯的是**按要不要花 token 拆**：

```
只读 / 即时 / 不需要模型    sakura_repo  sakura_plan  sakura_experience  sakura_workspace
需要模型 / 耗时 / 会改代码   sakura_run   sakura_delegate
```

前一类随时可以调，后一类会阻塞很久。想用 `pi config` 控制成本时，这条线比模块线有用。

---

## 2. 打包：`package.json` 的 `pi` 字段

```json
{
  "name": "my-pi-agent",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*", "typebox": "*" },
  "devDependencies": { "@earendil-works/pi-coding-agent": "0.85.1", "typebox": "1.1.38" }
}
```

三条硬约束（`pi-core/coding-agent/core/pi-manifest.ts:5-27` 是解析代码，别猜）：

1. **只有 4 个 key 被认**：`extensions` / `skills` / `prompts` / `themes`。
2. **值必须是字符串数组**，且每个元素都得是 string。解析是
   `Array.isArray(entries) && entries.every(e => typeof e === "string")` —— **有一个元素类型不对，
   整份 manifest 被丢弃**，插件一个都不加载，而且没有任何提示。这是最容易踩的坑。
3. 路径相对包根，支持 glob 和 `!排除`。

不写 `pi` 字段也行：Pi 会按约定目录 `extensions/` `skills/` `prompts/` `themes/` 发现。
但约定发现**只在顶层、不递归**，所以稍微复杂一点的包就用 manifest 显式列出。

### Pi 自带的包放 peerDependencies

`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、
`@earendil-works/pi-tui`、`typebox` —— Pi 已经提供它们。按官方要求写 `peerDependencies: "*"`，
版本用 `devDependencies` 锁。放进 `dependencies` 会让 pi 再装一份，**扩展和宿主拿到两份实现**
（同类问题别的地方也出过：typebox 的不同实例会让 schema 识别变得不可预期）。

你自己的第三方依赖放 `dependencies`，`pi install` 时会跑 `npm install` 自动装。

---

## 3. 会被静默吃掉或直接起不来的坑

按「症状 → 原因 → 做法」排。前四条是本机实测踩出来的。

### ① 没写 `export default` → pi 直接退出，什么都起不来

```
Ext:  export function myPlugin(pi) {}          ✗
Good: export default function myPlugin(pi) {}   ✓
```

`loader.ts:513` 是 `jiti.import(path, { default: true })`，`loader.ts:517` 拿到的不是函数就
返回 `undefined`，最终报 `does not export a valid factory function`。
然后 `main.ts:898-905`：只要有扩展加载错误就 **`process.exit(1)`**，交互模式也一样，
并提示 `Hint: Start without extensions using "pi -ne"`。

推论：**不要往 `extensions/` 放没有 default export 的辅助文件**（比如 `utils.ts`、`types.ts`）——
它会被当成插件加载并失败，整个 pi 起不来。共享代码放包内其它目录，或放子目录（子目录只有
`index.ts` 会被当插件加载）。

### ② `/命令` 同名 → 优先级高的默默吃掉另外两个

斜杠命名空间是共用的一套，优先级：

```
扩展命令 /cmd   >   /skill:<name>   >   /<prompt 模板名>
```

三者同名时只有扩展命令生效，**另外两个永远不会被执行，也没有任何警告**。实测：命令、技能、
prompt 都叫 `example` 时，`/example` 只剩扩展命令，技能和模板静默失效。

做法：命令用动词、prompt 模板带后缀、技能带 `-skill`。别指望 Pi 帮你发现冲突。

### ③ `tools` 白名单是**全局**的，会把自定义工具一起挡掉

```ts
// 想"不给内置工具"，结果连自己的工具也没了
createAgentSession({ tools: [], customTools: [myTool] })   // ✗ myTool 不可用
createAgentSession({ tools: ["myTool"], customTools: [myTool] })  // ✓ 白名单点名
```

`allowedToolNames` 对所有工具生效（`agent-session.ts:2694` 的 `isAllowedTool`）。
这个坑属于**只在 SDK 里嵌 Pi** 时才会遇到（写插件走 `registerTool` 不受影响），但表现是
"模型就是不调我的工具"，没有报错，极难查。

### ④ provider 报错时 `prompt()` 不会 reject

```ts
await session.prompt("...");   // 网络断了这里也会正常 resolve
```

错误被写进最后一条 assistant 消息：`stopReason: "error"` + `errorMessage`，`content` 为空。
不看这两个字段就会把一次 Connection error 当成任务成功。凡是拿 Pi Session 干活的地方都要判：

```ts
const last = messages.findLast((m) => m.role === "assistant");
if (last?.stopReason === "error") throw new Error(`model call failed: ${last.errorMessage}`);
```

### ⑤ `ctx.hasUI` 在 print / json 模式是 false

`-p`（print）和 `--mode json` 下 `ui.confirm` / `ui.select` / `ui.input` 不可用。
在权限门里必须先判：

```ts
if (!ctx.hasUI) return { block: true, reason: "需要确认，但当前模式没有 UI" };
```

不能"当作用户同意了"，也不能直接调 —— 会挂。

### ⑥ 自定义工具不写 `promptSnippet` → 模型更容易忽略它

工具 schema 一样会发给模型，所以能调用；但系统提示的 `Available tools` 一节里不会出现它。
想让它被优先想到就补：

```ts
promptSnippet: "一个行的说明，出现在 Available tools 里",
promptGuidelines: ["Use my_tool when …"],   // 必须点出工具名，否则模型不知道"this"指谁
```

### ⑦ 技能缺 `description` → 静默忽略

`SKILL.md` 必须有 frontmatter，且 `name` + `description` 都要有；`name` 只能是小写字母/数字/
连字符（不能首尾连字符、不能连续连字符，≤64 字符）。缺 description 不会报错，就是不见了。
`description` 决定它什么时候被加载，写具体，别写 "Helps with X"。

### ⑧ import 了没声明的包 → 本地能跑，`pi install` 之后炸

本地 `node_modules` 有你随手装的包，扩展跑得好好的；装到别的机器上 `ERR_MODULE_NOT_FOUND`。
`scripts/check-plugin.mjs` 会扫出来。

---

## 4. 体检脚本

```bash
node scripts/check-plugin.mjs .        # 或 node scripts/check-plugin.mjs templates/pi-plugin
```

它检查的全是「Pi 或 npm 不会告诉你」的那几类：

- 每个 `extensions/*.ts`（按 Pi 的发现规则，含一层 `<dir>/index.ts`）有没有 `export default` 函数
- `pi` 字段的 key 和值类型（值不是 `string[]` 会丢整份 manifest）
- manifest 里的路径/glob 是否存在
- `SKILL.md` 的 frontmatter、`name` 合法性、description
- prompt 模板是否非空
- 扩展 import 的裸包名有没有写进 `dependencies`/`peerDependencies`
- Pi 自带的包放在了 `dependencies`（建议改成 `peerDependencies`）

退出码 1 = 有必须修的。它自己的行为有测试（`tests/unit/plugin-check.test.ts`），
每条错法都断言会被拦下——不会出现"体检通过但其实没用"。

---

## 5. 加载失败时怎么查

先看退出时的诊断：加载失败会打印

```
Failed to load extension "<path>": <原因>
Hint: Start without extensions using "pi -ne".
```

- `does not export a valid factory function` → 坑 ①（少了 `export default`）
- `Cannot find module 'x'` → 坑 ⑧（依赖没声明）或相对路径写错
- 报错在别的包上 → 全局装的东西坏了。用 `pi -ne` 完全跳过扩展启动，
  再 `pi config` 逐个禁用定位

只想让某次运行干净：`pi -ne`（`--no-extensions`）；想临时试一个包：`pi -e <路径>`。

---

## 6. 打包成"自己的 agent"的检查清单

```
[ ] node scripts/check-plugin.mjs . 通过
[ ] pi -e ./extensions/<每个插件>.ts -t <它的工具> -p "…" 真能调用（每个插件都过一遍）
[ ] pi -e "$PWD" -p "list your available tools" 里能看到全部工具（验证 manifest 生效）
[ ] 技能出现在可用列表里（pi -e "$PWD" --tools read -p "list your available skill names"）
[ ] prompt 模板能展开（pi -e "$PWD" -p "/<模板名> <参数>"）
[ ] 权限门在无 UI 模式下是拦下而不是崩（用 -p 试一次危险命令）
[ ] package.json 里 keywords 有 "pi-package"，name/version 定好
[ ] 第三方依赖都在 dependencies，Pi 自带的都在 peerDependencies
[ ] git 提交；要发布就 pi install git:github.com/<you>/<repo>@v1（锁 tag，别锁 main）
```

第 2 条不能省。**静态体检过不了 Pi 的加载语义**——它只能证明文件长得对，
证明不了 api 接得对。本仓踩过的两个最难的 bug（工具被白名单吃掉、provider 报错被当成功）
都是"真跑一遍"才发现的。

---

## 7. 发布形态

| 形态 | 怎么做 | 什么时候用 |
|---|---|---|
| 本地目录 | `pi install /绝对路径` | 自用、还没稳定 |
| 项目内 | `pi install -l ./` | 团队共享，settings 跟着仓库提交 |
| git | `pi install git:github.com/you/repo@v1` | 对外发布（**锁 tag 或 commit，别锁 main**） |
| npm | `pi install npm:@you/pkg@1.0.0` | 需要版本语义和 registry |

`pi install` 会写进 settings；`pi update --extensions` 会按 pinned ref 重新对齐 clone。
要发到 package gallery 就带 `pi-package` keyword，可选加 `pi.video` / `pi.image` 做预览。
