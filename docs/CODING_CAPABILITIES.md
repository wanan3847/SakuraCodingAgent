# 编码能力补齐：实施与验收

2026-10-13。本轮范围来自 [Codex / Pi 官方调研](CODEX_PI_REUSE_RESEARCH.md)，按 [功能清单](FEATURE_GAPS.md) 完成。继续复用 Pi 1.1.0 的公开会话、工具、模型、TUI、MCP 和包管理接口；没有另建 Runtime 或引入 Codex 内部实现。

## 已交付

| 能力 | 主要实现 | 验收覆盖 |
| --- | --- | --- |
| 项目说明与 Shell | runtime/project-instructions.ts、runtime/shell.ts | Git 根目录作用域、override 优先级、32 KiB、符号链接边界；原生 Bash 的执行审批 |
| 子 Agent 生命周期 | runtime/host-context.ts、orchestrator/delegate.ts | 当前模型/思考级别继承、队列取消、退出等待、写工作区失败关闭、独立运行命名 |
| 共用预算与恢复 | runtime/run-budget.ts、业务运行检查点 | 真实 Pi 会话工具次数、usage 阈值取消、缺失数据拒绝、恢复累计账本 |
| 模型入口 | standalone/model-setup.ts 与 Pi InteractiveMode | 初始化向导、模型诊断、真实连接命令、显式云端登录入口、合并模型配置；切换直接用 Pi 原生 /model |
| 独立 MCP | standalone/mcp.ts、主入口与 workspace 扩展 | 原生动态注册工具可调用、真实 stdio 协议、运行时关闭回收进程、配置隔离与错误诊断 |
| 应用与撤销 | workspace/patch-selection.ts、apply-artifact.ts、code-checkpoint.ts | 文件选择、二进制/删除/重命名/中文路径、恢复意图、重复操作、拒绝后续改动覆盖、保留原有脏文件及暂存内容 |
| 验证与小任务 | 配置、verification、planning | 显式命令优先、空列表为未运行、npm/pnpm/yarn/bun 检测；低风险小任务使用确定性单 Agent 计划 |
| Python 与经验模式 | repo-intelligence/languages.ts、python-ast.py、experience/patterns.ts | 不执行仓库 Python 源码；语法错误显示覆盖缺口；三次独立验证来源才可提议候选 |
| TUI 与短入口 | extensions/sakura-orchestrator.ts、bin/sakura.mjs | 品牌页眉只保留一行标题；底栏、模型/供应商/思考级别与上下文用量全部用 Pi 原生 footer；40/60/80/120 列中文 /plan；短打包安装入口 |

## 最终验证

- 全量 `npm test`：**160/160，通过，零失败、零跳过**。安全用例需要真实 macOS 沙箱及临时 Unix socket；本次获批在受限执行环境外完成，没有删除保护检查。完整日志保存在源码工作区 `.sakura/release/capabilities/full-test.log`。
- 针对性组：24/24，通过；其中真实 Pi 会话的模型提供者边界使用确定性回复，不能据此声称已经通过所有真实模型任务。
- TypeScript 类型检查与 Pi 插件检查通过。package manifest 为 6 个 Sakura 扩展、6 个业务工具、5 个技能、2 个提示；独立宿主额外加载 3 个原生 MCP/codemode/tool_search 扩展工厂，共 9 个。
- 实际伪终端两轮检查：40、60、80、120 列全部通过，中文 `/plan` 可操作并正常退出。证据位于 `.sakura/frontend-evidence/terminal-check.json` 与对应终端日志。没有把确定性规划检查当作真实模型流式效果评测。
- `node scripts/check-short-install.mjs` 在临时 npm 全局前缀和独立 profile 中执行真实 `npm run app`、短初始化与宿主加载；检查非法参数拒绝、目标项目 Pi 设置不变及 Pi 1.1.0。最终包路径与 SHA-256 以 `.sakura/release/short-installed.json` 为准，安装测试不改个人 npm 全局目录。

源码复现：

```sh
npm ci --ignore-scripts
npm run check
npm run check:plugin
npm run check:standalone
node scripts/check-short-install.mjs
```

## 使用

在仓库根目录：

```sh
npm run app
sakura init
sakura
```

向导选择本地已有的 Ollama 模型；直接指定可用 `sakura init MODEL`。只打包用 `npm run pack`，分发工件为仓库根目录 `sakura.tgz`。全局安装需要 npm 全局目录可写。无需全局 Pi，配置保存在独立的 `~/.sakura/agent`。

`/subagent` 自动规划并执行，`/cancel` 取消，`/apply manifest.json --files a,b` 选择文件，`/undo` 撤销最近代码检查点。模型切换直接用 Pi 原生 `/model`；`sakura models` 和 `sakura connect` 提供配置及连接诊断。云端用 `sakura --cloud` 后 `/login`。完整说明见 [独立入口](STANDALONE.md)。

## 范围与保留结论

本轮没有更新服务器，也没有重跑 Linux 或长时间真实模型矩阵。此前 Linux 148/148 是历史源码副本证据，不能作为本轮新功能的 Linux 验收。

浏览器及其他语言服务通过显式配置的 MCP 接入；本轮真实 MCP 证据是 stdio 测试服务，没有下载浏览器或实跑 Playwright 页面。Python 仅提供 AST 定义及相对导入，完整引用/调用图仍限于 TS/JS。

预算根据已返回用量停止，有在途请求超出量。原生 write/edit 检查点保存触及路径的增量，不能恢复任意 Shell、MCP 或外部系统副作用。文件级选择已实现，逐 hunk、任意脏树合并及语义合并未纳入本轮。

既有矩阵与候选效果结论不变：技能候选因 8/9 低于基线 9/9 被拒绝晋升；工程测试通过不等于多 Agent、动态规划或技能进化已经证明性能改善。
