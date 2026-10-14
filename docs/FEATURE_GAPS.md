# Sakura 编码能力补齐状态

2026-10-13。依据 [Codex / Pi 官方调研](CODEX_PI_REUSE_RESEARCH.md) 实施，继续使用 Pi 1.1.0 公开 SDK。下表表示本轮明确范围的实现状态，不表示所有模型、语言或仓库都已经验收。

| 项目 | 本轮状态 | 实现与边界 |
| --- | --- | --- |
| 主 TUI Shell | 已实现 | 原生 Bash 流式输出、截断、超时和进程取消；模型调用与手动 `!` 都经过执行审批。network: deny 时拒绝非隔离 Shell。 |
| 项目说明 | 已实现 | 主/子会话使用同一 loader，Git 根目录到 cwd；AGENTS.override.md > AGENTS.md > CLAUDE.md，每目录选一个；独立 profile 说明加项目说明共 32 KiB，超额拒绝，符号链接不能逃出作用域。 |
| 模型配置 | 已实现 | `sakura init` 向导、`init MODEL`、`models` 诊断、`connect`；`--cloud` 显式启用云端。登录与模型切换直接复用 Pi 原生 `/login`、`/model`，没有独立切换命令。Ollama 初始化可增加/更新指定模型，保留其他模型与凭证。 |
| 子 Agent 控制 | 已实现 | DAG、独立委托继承当前模型、思考级别、审批和独立运行时；统一 `/cancel`、Ctrl+Shift+X、父 signal 和退出等待；隔离失败不原地写入；工作区与运行 id 有独立命名。 |
| 运行预算 | 已实现 | 主 TUI 每轮与其子任务共用账本；CLI DAG/委托各有根账本；工具次数在执行前预留；Token/费用按供应商已返回 usage 停止；恢复加载累计消耗，不清零。缺失用量遇到对应限额时停止。 |
| 小任务路由 | 已实现 | 小且低风险的新任务使用确定性单 Agent 计划，省去模型 Planner；复杂/高风险任务保留原有规划与验证。用户显式计划不被改写。 |
| 项目验证 | 已实现 | `verification.commands` 显式列表优先，包括空列表（报告未运行）；否则按 packageManager/锁文件识别 npm、pnpm、yarn、bun，保留 Python/Make/Cargo/Go。命令在工作区根目录执行；子目录用明确的 `cd ... && ...`。 |
| 文件选择与代码撤销 | 已实现 | `/apply manifest --files a,b` 或 CLI；二进制、删除、重命名由 Git 解析。应用前保存恢复意图，完成后保存代码检查点；主 TUI write/edit 在实际 settled 后保存触及路径的增量。`/undo` 或 `sakura undo` 撤销最新检查点，校验 HEAD、暂存区和工作区，保留此前的用户改动。 |
| 独立 MCP | 已实现 | 原生 codemode、tool_search、MCP factories，独立 mcp.json 与认证；CLI add/list/remove 与原生 `/mcp` 管理；不读取项目 .pi/mcp.json；动态工具不受错误的固定白名单限制。未配置服务器不会启动。 |
| 多语言结构 | 已扩展 | TS/JS 保留 compiler references/calls；有 python3 时增加 Python AST 定义和相对导入。Python 不执行仓库源码，不声称提供跨文件引用/调用推断。语法失败标为排除。其他语言通过 read/grep 或显式 MCP 语言服务接入。 |
| 浏览器能力 | 可选接入已实现 | 可配置 [Playwright MCP](https://github.com/microsoft/playwright-mcp)，工具调用走审批与 Pi 生命周期。项目自己的浏览器验收命令可列入 verification.commands。没有默认下载浏览器，也没有本轮真实浏览器/页面截图验收证据。 |
| 经验模式 | 已实现 | 可解释的规范化模式分组，输出经验来源和独立验证运行数；`experience patterns`、工具 action=patterns。三次不同运行有验证记录才标为可提议，仍不代表效果改善，更不自动批准发布。 |
| 短入口 | 已实现 | `npm run pack`、`npm run app`、`sakura`；无需全局 Pi。 |

## 验收范围

详见 [本轮实施与验收](CODING_CAPABILITIES.md)。新增检查使用真实 Pi 会话与工具管线，仅在模型提供者边界注入确定性回复；MCP 检查使用真实 stdio 协议进程。原有安全审批、技能发布事务和配对评估检查继续保留。

Token/费用停止阈值有在途请求超出量，不是绝不超支的金额锁。主 TUI 检查点只追踪原生 write/edit 触及路径，不能自动恢复任意 Shell、MCP 或外部进程的副作用；工程产物的完整 Git patch 可保存这些文件变更。逐 hunk 选择、任意脏工作区合并、语义合并、所有语言完整 LSP 和长时间真实模型矩阵仍不属于本轮交付。

此前固定评测维持原结论：完整 Sakura 20/30，no-multi 和 fixed-plan 各 25/30；技能候选基线 9/9、候选 8/9，拒绝晋升。这轮工程功能检查不能替代模型效果评测。LangSmith 继续为可选追踪导出方向，当前本地 events/metrics 已能运行和排障。
