# Codex / Pi 官方源码复用调研

日期：2026-10-13。状态：调研完成；随后完成第一至第四批实现，运行证据与能力边界见 [CODING_CAPABILITIES.md](CODING_CAPABILITIES.md)。下文“当前”均指实施前的调研快照。范围是补齐 Sakura 的日常编码能力；官网设计与服务器部署不在本次调研范围内。

## 1. 调研基线与方法

- 本机 Codex：`codex-cli 0.162.1`。调研官方仓库 [openai/codex](https://github.com/openai/codex) 的对应标签 `rust-v0.162.1`，实际 commit 为 `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`。源码副本位于 `/private/tmp/sakura-codex-research-01621`，用于只读研究；不是 Sakura 运行依赖。
- Sakura 锁定 Pi：`@earendil-works/pi-coding-agent` / `pi-ai` / `pi-tui` 1.1.0。逐项核对已安装包的公开导出、TypeScript 声明、官方 SDK 示例与实现。
- 使用本地 `pi-agent` Skill 辅助定位参考资料。该 Skill 的参考版本是 0.99.2，不能直接把示例当作 1.1.0 合同；下面的接口均另行核对当前安装包。
- 对照 Sakura 现有 `standalone/`、`runtime/`、`orchestrator/`、`verification/`、`workspace/` 源码。没有运行 Codex 源码的构建或测试，没有调用付费模型，也没有修改个人 Codex / Pi 配置。

结论：继续以 Pi 公开 SDK 为运行时，直接接入它已经提供的能力。Codex 官方源码用于参考权限、生命周期、预算和 Diff 的设计；现阶段没有必须增加第二个 Agent Runtime 的需求。

## 2. 逐项复用决定

| 能力 | Pi 已提供的基础 | Codex 源码参照 | Sakura 的决定 |
| --- | --- | --- | --- |
| 主 TUI 命令执行 | `createBashToolDefinition` / `createBashTool`、`BashOperations`、原生输出截断与工具渲染 | `unified_exec/`、`tools/orchestrator.rs` | 复用 Pi 工具，接入 Sakura 权限和执行后端，不重写 shell 工具协议 |
| 项目指令 | `loadProjectContextFiles`、`agentsFilesOverride`、`getAgentsFiles` | `agents_md.rs` 的项目根、文件优先级与总字节预算 | 加载项目说明与独立 Sakura 用户说明，统一主/子 Agent 的来源和作用域 |
| 子 Agent 控制 | `AgentSession.abort()`、`steer()`、`followUp()`、`waitForIdle()` | `agent/child_config.rs`、`agent/control/` | 修复现有 delegate 路径的接线，复用已有 DAG 和 Pi 会话 |
| 模型与鉴权 | `ModelRuntime`、`resolveCliModel`、原生 `/login` / `/model` | Codex 的初始化与有效配置继承 | 改善入口和错误提示，继续使用 Pi 的 provider/auth 层 |
| 总运行预算 | 完成消息的 usage、会话事件、取消与现有 trace | `rollout_budget.rs` 与 `agent/control/budget.rs` | Sakura 增加共享预算账本与调度门槛，不复制模型请求循环 |
| MCP / 工具发现 | `createMcpExtension`、`createToolSearchExtension`、`createCodemodeExtension` | Codex 的 MCP 工具与会话生命周期 | 显式接入 Pi 原生实现，并保持 Sakura 配置隔离 |
| Diff 审阅 | Pi `edit` 的 `details.diff` / `details.patch`、Sakura 现有 Git 产物 | `turn_diff_tracker.rs` | 补产物审阅与选择性应用；对话恢复与文件恢复分别处理 |
| 验证、多语言与浏览器 | Pi 的基础工具、MCP 和扩展承载能力 | Codex 的工具集成方式 | 验证配置由 Sakura 补；语言服务和浏览器用可选工具接入，不能声称核心已自带 |

Pi 公共 SDK 与官方示例见 [SDK 文档](https://pi.dev/docs/latest/sdk)、[1.1.0 SDK 示例目录](../node_modules/@earendil-works/pi-coding-agent/examples/sdk/)；接口以本地 1.1.0 的 `dist/index.d.ts` 为准。

## 3. 源码确认的重要边界

### A. 不能只在主 TUI 的工具数组加一个 bash

Sakura 的主 TUI 确实没有启用 `bash`；写入角色子 Agent 则已有该工具。当前 `guard.ts` 明确指出普通 shell 可以绕开文件和网络作用域，默认需要授权。

Pi 的 `BashOperations.exec` 接收命令、cwd、signal、timeout 和输出回调，允许在保留原生工具 schema/渲染的同时替换执行后端。Sakura 已有进程组取消和受保护验证执行，但该验证执行器目前聚合输出，不是现成的 TUI 流式后端；需要补接线。

Codex 把审批、沙箱选择和执行尝试集中处理，而进程管理单独负责输出、PTY 和取消。Sakura 应沿用这个职责划分。审批缓存只能绑定明确动作、执行目录和有效权限；策略变化后不能继续使用旧授权。受保护执行失败时，不得静默退回不受限执行。

参照：[Codex 执行管理](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/unified_exec/mod.rs)、[工具审批与沙箱](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/tools/orchestrator.rs)。Sakura 接点：`src/standalone/main.ts`、`extensions/sakura-workspace.ts`、`src/workspace/guard.ts`、`src/verification/test-runner.ts`。

### B. AGENTS.md 与个人 Pi 配置隔离可以同时成立

Pi 的 context files 与 `.pi/settings.json`、扩展和技能发现是不同机制。关闭外部扩展发现并不要求关闭项目说明文件。

但两者的搜索边界不完全相同：当前 Pi 加载器会沿 cwd 向上直到文件系统根；调研版本的 Codex 以项目根标记划定搜索边界，没有项目根时只考虑 cwd，还限制指令的总字节数。Sakura 不能只把 `noContextFiles:true` 改为 false 就宣称完成隔离。

实施需要：复用 Pi 文件名优先级与 context-file 接口，限定规范化路径的项目范围和独立用户目录，声明预算与截断，展示加载来源；对链接 worktree 避免重复注入同一逻辑仓库指令。主/子 Agent 应使用同一规则。

参照：[Codex 项目指令加载](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/agents_md.rs)、[Pi 配置说明](https://pi.dev/docs/latest/configuration)。Sakura 接点：`src/standalone/profile.ts`、`src/runtime/create-agent.ts`。

### C. delegate 的缺口是配置与生命周期接线

Sakura 工程 DAG 已有取消、恢复和指令投递。独立委派路径的 `_signal` 没有传入 `delegateTasks`，也没有同 DAG 一样传入当前模型和审批回调；隔离创建失败还会退回原地工作。

Codex 子 Agent 构建有效配置时继承当前模型、审批策略、cwd 和权限快照，而不是只复制旧的静态配置。Sakura 应把这些有效状态传给现有 `createPiAgentRunner`：父取消停止排队与活跃会话，清理在产物保存之后进行，取消状态和失败状态分开报告；要求隔离的写任务不再自动原地降级。

参照：[Codex 子 Agent 配置继承](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/agent/child_config.rs)、[Agent 树生命周期](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/agent/control/runtime.rs)。Sakura 接点：`extensions/sakura-subagent.ts`、`src/orchestrator/delegate.ts`、`src/runtime/pi-agent-runner.ts`。

### D. 输入上下文预算不是整次运行预算

Sakura 的 Context Pack、超时、并发和重规划次数已经有限制；整次运行的总消耗尚没有同等约束。Codex 源码包含根会话树共享的 rollout budget，按 usage 记账，预算耗尽返回明确错误。

Sakura 应在规划、执行、重规划和所有子 Agent 之间共享预算，恢复时继续使用原账本，记录停止原因。usage 缺失不能当零；并发请求可能产生在途消耗，基于已返回 usage 的停止门槛不能被宣传为绝不超出的费用硬上限。

还确认了一项实现陷阱：Pi 的 `before_provider_request` handler 抛错会被捕获并报告，然后继续返回 payload。不能依赖在该 hook 里 throw 来实现预算或权限的安全门。新任务/请求门槛必须建立在实际调度与执行边界上。

参照：[Codex 共享预算](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/rollout_budget.rs)、[Agent 预算接线](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/agent/control/budget.rs)。Sakura 接点：`src/run.ts`、`src/orchestrator/`、`src/telemetry/`。

### E. 原生 MCP 仍需在 SDK 宿主里显式装配

Pi CLI 自带 MCP，不表示所有 SDK 会话自动具备 MCP。官方 SDK 示例明确装配三个 extension factories，并在会话启动时连接服务器。Sakura 当前没有装配它们。

公开 `McpExtensionOptions` 提供 `loadConfig`，`LoadedMcpConfig` / `McpServerConfig` 也有公开导出。可据此只读写 Sakura 的配置来源，使用独立凭证存储；不能直接使用默认的项目 `.pi/mcp.json` 加载逻辑破坏隔离。默认不启动未明确配置的服务器。子 Agent 继续只接收明确授权的工具。

MCP 服务器是外部进程或远程服务，内置工具管线与连接生命周期可以复用，但任意服务器的文件/网络权限不能靠工具名称推断。浏览器或语言服务应作为明确配置的可选能力接入。

参照：[Pi MCP 文档](https://pi.dev/docs/latest/mcp)、本地官方 `examples/sdk/14-codemode-mcp.ts`。Sakura 接点：`src/standalone/profile.ts`、`src/standalone/main.ts`。

### F. 会话恢复不等于代码撤销

调研版本的 Codex 已移除 `thread/rollback`，使用 `thread/revert`；协议注释明确它只改变持久化对话历史，不还原本地文件。不能照搬旧教程中的 rollback/ghost snapshot 说法。

Codex 的 `TurnDiffTracker` 跟踪已提交 apply_patch 修改的前后内容；它不是所有 shell/外部进程修改的完整备份。Pi 的会话树与压缩同样属于聊天状态。

Sakura 应先在已有 artifact/baseCommit/patchSha256 基础上增加逐文件选择和应用回执；后续代码检查点要校验当前内容是否仍等于 Agent 写入后的版本，避免覆盖用户后来修改的文件。二进制、重命名和 shell 产生的变化需要明确的覆盖边界，不应一开始承诺任意逐块撤销。

参照：[Codex thread/revert 协议](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1273)、[Diff 跟踪](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/turn_diff_tracker.rs)。Sakura 接点：`src/workspace/artifacts.ts`、`src/workspace/apply-artifact.ts`、`extensions/sakura-workspace.ts`。

## 4. 实施分批与验收行为

| 批次 | 改动 | 必须成立的行为 |
| --- | --- | --- |
| 第一批 | 主 TUI 命令工具、项目说明加载、delegate 的有效配置和取消 | 能在主对话执行并看见真实输出；拒绝命令不会执行；主/子 Agent 看到正确项目指令；父取消不会留下继续写文件的子任务；要求隔离的任务不原地降级 |
| 第二批 | 复用模型选择/鉴权入口、原生 MCP 的独立配置接入 | 选择模型不要求手改多个文件；保持 local-only 边界；未配置服务器不会启动；不读写个人/项目 Pi 配置；会话关闭会回收 MCP 进程 |
| 第三批 | 共享运行预算、单/多 Agent 路由、显式验证命令 | 并行与重规划不会各自重置预算；未知 usage 明确显示；简单任务不无故启动多人流水线；按项目实际包管理器或显式命令检查 |
| 第四批 | 产物逐文件接受、变更检查点与安全撤销 | 只应用选中的文件；校验基线/内容；用户后续修改不会被撤销覆盖；对话分支不冒充文件恢复 |
| 后续扩展 | 语言服务、真实浏览器验收、经验聚类 | 通过明确配置的原生扩展/MCP 接入；对新语言和网页能力分别给出实测范围；候选技能仍须效果门槛与可信发布流程 |

上表保留实施目标；随后执行的验收见 [本轮实施记录](CODING_CAPABILITIES.md)。现有评测仍未证明多 Agent 普遍提高成功率，不能靠新增功能数量取代效果评测。

## 5. 保留的架构决定

1. 不修改 Pi core，不使用 Pi `dist/**` 内部模块作为运行依赖；源码内部实现仅供调研，实际接线使用公开导出。
2. 不新增统一 Runtime 框架，不把 Codex CLI 作为 Sakura 必装依赖，不混用个人 Codex / Pi 凭证。
3. 不重新实现 provider、Agent Loop、聊天会话库、压缩、基础读写工具、MCP transport 或 TUI 框架。
4. Codex 仓库为 Apache-2.0。当前只参考机制；若后续确实复制代码或移植实现，记录来源、版本和许可，并保留对应声明。Rust 运行时模块不宜直接搬进当前 TypeScript SDK 宿主。
5. 这份调研不能替代运行验收；源码存在某项机制，也不等于所有配置/平台都默认启用它。
