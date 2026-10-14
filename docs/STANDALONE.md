# Sakura 独立工作台

## 终端

`sakura init` 进入选择向导，`sakura init YOUR_MODEL` 直接配置指定模型。模型需要已经安装在本机 Ollama；初始化不会下载模型。首次初始化会准备终端搜索工具；离线初始化可加 `--offline`，自行保证 fd/rg 可用。

在目标项目目录运行 `sakura`，或用 `sakura tui --project /path/to/project` 打开终端。`--continue` 恢复该项目最近的独立会话，`--theme sakura-night` 使用深色主题。模型也可由 `--model ollama/MODEL` 指定。

终端显示阶段、已完成任务、正在运行的任务和最近工具动作；目录/分支、token 与上下文用量、右下角的供应商 · 模型 · 思考级别都用 Pi 原生底栏，Sakura 不重复实现。`/plan 任务` 生成计划，`/subagent 任务` 自动规划并执行子 Agent，`/history` 查看历史。`Ctrl+Shift+X` 取消当前工程运行。模型与供应商切换用 Pi 原生 `/model` 和 `/login`。

没克隆仓库的机器可以直接一行安装（自带 SHA-256 校验）：`curl -fsSL https://github.com/wanan3847/SakuraCodingAgent/releases/latest/download/install.sh | sh`。源码目录用 `npm start`；`npm run app` 一次完成打包安装，之后直接运行 `sakura`。只打包用 `npm run pack`，输出 `sakura.tgz`；分发单个安装包时可用 `npm i -g ./sakura.tgz`。旧的源码入口和 `init --ollama-model NAME` 保留兼容。安装包包含固定版本的 SDK 和 TypeScript 加载器，不需要全局 Pi，也不需要 `pi install`。

## 项目网站与本地记录工具

`sakura web --project /path/to/project` 监听 http://127.0.0.1:4317。首页是项目介绍网站，呈现产品目标、核心能力、模块设计和安装方式；`/guide.html` 是使用指南。首页不调用运行 API 或读取私有配置。

`npm run site:build` 将纯静态网站导出到 `.sakura/site-dist`，可以单独部署，不需要 Agent 进程、模型或后端。源码使用相对资源路径，可以部署在域名子路径。

已有只读运行记录工具位于 `/workbench`，读取项目 `.sakura/runs` 中的 checkpoint、事件、metrics 和 diff。`--runs PATH` 可添加记录根目录，`--port 4320` 改本地端口。静态网站不包含该工具。

本地服务只监听 loopback，限制 Host/Origin、拒绝写请求与根目录外的符号链接文件。远程访问可使用 SSH 端口转发。

## 配置隔离

默认 `~/.sakura/agent/{settings.json,models.json,auth.json,sessions}`。`--home PATH` 或 `SAKURA_HOME` 可调整根目录；启动器在 SDK 初始化之前设置独立路径。

不读取个人 `~/.pi`、项目 `.pi/settings.json`、自动发现的外部扩展与技能。项目内的 `.sakura` 继续保存工程产物、计划、运行与经验。自身配置隔离不会阻止模型读写项目，也不能替代执行沙箱。

`init MODEL` 只增加/更新独立 Ollama 配置里的指定模型并设置默认值，保留其他模型与凭证。切换模型直接使用 Pi 原生 `/model`，沿用其列表、搜索和选择，不另做切换命令。`sakura models` 列出配置诊断，`sakura connect` 发起一个短模型请求检查真实连接。云端运行用 `sakura --cloud`，然后使用 Pi 原生 `/login` 和 `/model`。`sakura doctor` 展示独立路径、资源数量、项目指令来源与 MCP 配置错误，不输出凭证。

## Pi 生态

直接使用原生 Pi 包管理与资源加载，不需要转换技能格式。`sakura install npm:PACKAGE@VERSION` 安装，`sakura install /path/to/package` 加载本地包，`sakura packages` 查看，`sakura remove SOURCE` 移除。扩展、技能、提示词、主题都从 Sakura 的独立配置加载，个人 Pi 和目标项目的 Pi 配置不会被改动。当前 SDK 固定为 1.1.0，第三方扩展仍须匹配其 API。

`/run` 是 `/subagent` 的兼容别名，两者使用同一执行流程。

独立终端保留所有 `/sakura-*` 长命令；`/resume` 是 Pi 原生会话恢复，工程运行恢复使用 `/sakura-resume`。

## 追踪

本地 events/metrics 已用于任务时间线、Agent 和工具调用、token 用量、验证与错误展示，默认不开云追踪。LangSmith 可以以后作为可选导出器接入，适合跨服务器集中排障和对照评估，不作为 Sakura 独立运行的前置条件。

## 新增工程入口

`/apply manifest.json --files src/a.ts,src/b.ts` 接受选定文件；`/undo` 撤销最新代码检查点。`sakura apply manifest.json --files src/a.ts` 和 `sakura undo` 是对应 CLI。HEAD、暂存区或后续工作区变更不匹配时，撤销会拒绝覆盖。主 TUI 只为原生 write/edit 保存路径增量；Shell/MCP 的任意副作用不能自动撤销。

`sakura mcp add NAME -- COMMAND ARGS` 配置 stdio 服务；`sakura mcp add NAME server.json` 导入单个 HTTP/stdio 服务条目；`sakura mcp list` 只显示名称、开启状态和 exposure；`sakura mcp remove NAME` 移除。连接、OAuth 和 exposure 在 TUI 原生 `/mcp` 管理。配置来源是 `~/.sakura/agent/mcp.json`，项目 .pi/mcp.json 不参与。服务器进程在配置后由原生 MCP 启动，不继承到没有明确工具授权的子 Agent。

可选浏览器示例（需要用户环境安装浏览器，版本可自行固定）：

```sh
sakura mcp add browser -- npx @playwright/mcp@latest --headless --isolated
```

配置与工具入口采用 [Playwright MCP 官方方案](https://github.com/microsoft/playwright-mcp)；这不是本轮已执行的浏览器页面验收。其他语言服务也可通过显式 MCP 配置接入。

项目配置示例：

```yaml
runtime:
  budget:
    maxTokens: 200000
    maxToolCalls: 100
    maxCostUsd: 5
verification:
  commands:
    - pnpm run typecheck
    - pnpm run test
```

预算覆盖该轮主 Agent、Planner 和子 Agent，恢复继承账本。工具次数在派发前限制，Token/费用按已返回用量停止，会有在途超出量；没有配置限额就不设置上限。验证命令仍须遵守审批策略。

Python 仓库提供 AST 定义/相对导入（需要 python3），TS/JS 保留引用/调用图。`sakura experience patterns` 查看重复模式和独立验证运行来源，候选发布门槛保持不变。
