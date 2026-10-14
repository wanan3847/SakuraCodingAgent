# 🌸 Sakura Coding Agent

基于 [Pi](https://github.com/earendil-works/pi) 的工程 Agent。终端负责计划、编码、验证与交付，浏览器提供项目介绍网站和只读运行工作台，视觉采用浅樱花粉的 Apple 明亮风格。

Sakura 不自造 Agent 基础设施：模型调用、Agent Loop、会话、工具、终端 UI、资源加载（扩展/技能/提示/主题）与 MCP 全部复用 Pi 官方包，Sakura 只实现**动态规划（DAG）、多 Agent 调度、仓库理解、worktree/sandbox、经验与技能演进**，以及贯穿执行的**验证闭环**。

> 仓库根目录就是 npm 包根目录。`npm ci` → `npm i -g .` 即可得到全局 `sakura` 命令，不需要安装 Pi。

## 目录

- [环境要求](#环境要求)
- [安装](#安装)
- [第一次运行](#第一次运行)
- [终端界面](#终端界面)
- [命令](#命令)
- [配置与隔离](#配置与隔离)
- [模型与供应商](#模型与供应商)
- [MCP、扩展包与主题](#mcp扩展包与主题)
- [网站与工作台](#网站与工作台)
- [工程流程](#工程流程)
- [开发](#开发)
- [打包与发布](#打包与发布)
- [卸载](#卸载)
- [故障排查](#故障排查)
- [已知边界](#已知边界)
- [文档](#文档)

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | `>= 22.19`（开发检查使用 26.10）；`node --test` 直接运行 `.ts`，不需要额外转译 |
| 系统 | macOS 或 Linux（受保护执行在 macOS 系统沙箱、Linux bubblewrap/seccomp 上验证） |
| 模型 | 本机 Ollama（默认，只接受 loopback 端点）或云端 provider |
| 可选 | `fd` / `rg`（首次 `sakura init` 会检查；缺失时用内置工具降级） |

## 安装

### 一行安装（curl，适合没克隆仓库的机器）

```sh
curl -fsSL https://github.com/wanan3847/SakuraCodingAgent/releases/latest/download/install.sh | sh
```

脚本会：检查 Node >= 22.19 与 npm → 从 GitHub Release 下载 `sakura.tgz` 与 `SHA256SUMS` → **校验 SHA-256**（不通过就直接中止，不安装）→ `npm i -g` → 自检并把 `sakura` 位置不在 PATH 的情况告诉你。常用参数：

```sh
# 指定版本 / 指定安装目录（不需要 sudo）/ 只预演
curl -fsSL <上面的地址> | sh -s -- --version 0.1.0
curl -fsSL <上面的地址> | sh -s -- --prefix "$HOME/.local"
sh scripts/install.sh --tarball ./sakura.tgz --dry-run
```

### 推荐：npm

包本身就是标准 npm package（`bin` + `files` 白名单 + 锁定的运行依赖），所以最稳的安装路径是 npm：

```bash
git clone <repo> && cd SakuraCodingAgent

# 从源码：装依赖并全局安装
npm ci --ignore-scripts
npm i -g .

# 或者用打包产物（适合分发到别的机器）
npm run pack          # 生成 ./sakura.tgz
npm i -g ./sakura.tgz

# 一条命令完成「打包 + 全局安装」
npm run app
```

安装后验证：

```bash
sakura --help
sakura doctor         # 独立配置路径、资源数量、项目指令来源、MCP 配置错误
```

**为什么默认给 npm、把 curl 当便捷层**：包就是 npm package，npm 直接提供版本锁定、完整性校验、依赖解析和一条命令卸载；`curl | sh` 只是把「下载 + 校验 + 全局安装」包成一行，同样需要本机有 Node/npm，并且只从 GitHub Release 取带 `SHA256SUMS` 的官方工件。

全局安装需要 npm 全局目录可写（不需要超级用户；用 `npm prefix -g` 查看位置）。用 `nvm`/`fnm` 管理 Node 时，全局命令会随 Node 版本切换。

### 从本地安装包创建干净宿主

分发到另一台机器时用打包产物；这一步不需要宿主预装 Pi，运行依赖随包安装：

```bash
npm run pack            # 在源机器上生成 ./sakura.tgz（打开 SHA-256）
# 把 tarball 拷到目标机器后：
npm i -g ./sakura.tgz
sakura init
```

如果确实要让 Sakura 作为 Pi package 与宿主的 Pi 共享配置（默认安装并不需要这样做），用同版本 1.1.0 的宿主：

```bash
npm exec -- pi install -l "$PWD"
npm exec -- pi --use-theme sakura-light
```

Pi 的本地来源必须指向已解包的资源目录；宿主版本不同时先做兼容验证（见 [UPSTREAM](docs/UPSTREAM.md)）。

## 第一次运行

```bash
sakura init              # 向导：选择本机已安装的 Ollama 模型
sakura init YOUR_MODEL   # 直接指定模型名
sakura                   # 启动终端工作台
```

`init` 会创建独立配置目录并写入默认模型，不会下载模型、不会修改 `~/.pi`。它同时检查 `fd`/`rg` 是否可用（离线可用 `--offline` 跳过）。

使用云端模型：

```bash
sakura --cloud           # 本次会话关闭 local-only 限制
# 然后在终端里用 Pi 原生 /login 登录 provider，再用 /model 选择模型
```

## 终端界面

- **页眉**：只有一行 `🌸 Sakura Coding Agent`，不重复画命令提示。
- **进度**：Sakura 业务阶段（规划中 / 编码中 / 验证中 / 已应用 / 失败…）、完成任务数、当前工具动作。
- **底栏**：Pi 原生 footer —— 目录与 Git 分支、token 与上下文用量（`0.0%/16k (auto)`）、右下角 `(provider) model • thinking`、扩展状态行。模型切换、供应商登录、思考级别都用 Pi 原生界面，Sakura 不另做一套。
- **主题**：`sakura-light`（默认）与 `sakura-night`；用 Pi 原生 `/settings` 或启动参数 `--theme sakura-night` 切换。

常用按键（Pi 原生 + Sakura 扩展）：

| 按键 | 作用 |
| --- | --- |
| `ctrl+o` | 展开完整启动帮助与已加载资源 |
| `esc` | 中断当前生成 |
| `ctrl+c` / `ctrl+d` | 清空输入 / 退出 |
| `/` | 命令补全 |
| `!` | 执行 shell 命令（经审批） |
| `ctrl+shift+x` | 取消正在运行的 Sakura 工程任务 |

## 命令

### 终端内短命令（独立模式）

| 命令 | 作用 |
| --- | --- |
| `/plan <任务>` | 生成 Task DAG 计划并保存 |
| `/subagent <任务>` | 自动规划 + 调度子 Agent 执行整个任务（`/run` 为兼容别名） |
| `/cancel` | 取消当前 Sakura 任务并保存产物 |
| `/history` | 列出运行记录与检查点 |
| `/instruct <runId> <taskId> steer\|follow-up\|plan <文本>` | 向运行中的任务定向补充指令 |
| `/apply manifest.json --files a,b` | 接受全部或选定文件并复验 |
| `/undo` | 撤销最近一次已应用的代码检查点 |
| `/diff <artifact.json>` | 预览已保存产物 |
| `/repo <动作>` / `/experience [查询]` | 仓库索引查询 / 经验库检索 |
| `/status` / `/workspace` / `/delegate` | 最近一次运行指标 / 工作区状态 / 并行委托 |

同时保留 `/sakura-*` 长命令（Pi 插件模式下用它们避免占用宿主命名空间）；`/resume` 留给 Pi 原生会话恢复，Sakura 的 run 恢复是 `sakura-resume`。

### 终端外的 CLI

```bash
sakura tui [--model provider/id] [--theme sakura-night] [--continue]
sakura init [MODEL] [--context-window N] [--max-tokens N] [--offline]
sakura models | connect | doctor
sakura web [--port 4317] [--project PATH] [--runs PATH]
sakura mcp list | add NAME config.json | add NAME -- CMD ARGS | remove NAME
sakura install npm:PKG@VER | remove SOURCE | packages
sakura plan "任务" [--files a,b]
sakura run "任务" | --plan <path>
sakura history | status | resume <runId> | instruct <runId> <taskId> <mode> "文本"
sakura verify [dir] | diff <artifact.json> | apply <artifact.json> [--files a,b] | undo <checkpoint.json>
sakura repo <动作> | experience [查询] | candidate <动作> | delegate "a" ; "b"
```

`plan`、`repo`、`verify`、`diff` 不需要模型；`run`、`delegate`、`candidate evaluate` 需要可用模型。加 `--json` 可输出结构化结果。

## 配置与隔离

默认配置目录 `~/.sakura`（`SAKURA_HOME` 或 `sakura --home PATH` 可改）：

```
~/.sakura/
├── agent/
│   ├── settings.json       主题、默认模型/供应商、思考级别
│   ├── models.json         自定义 provider 与模型
│   ├── auth.json           provider 凭证（/login 写入，权限 0600）
│   ├── models-cache.json   模型目录缓存
│   ├── mcp.json            Sakura 自己的 MCP 服务
│   └── sessions/           会话记录
├── settings-scope/         独立 settings/Pi package 作用域
└── <按需>                  运行记录、计划、经验、候选技能
```

- **不导入** `~/.pi`、项目 `.pi/settings.json` 或外部自动发现的扩展/技能/提示词；只加载 Sakura 自带资源与显式安装到独立配置的 Pi 生态包。
- 目标项目的 `AGENTS.md` / `AGENTS.override.md` / `CLAUDE.md` 会作为项目说明加载（每个目录取一个，有大小上限，符号链接不能逃出作用域）。
- 配置隔离**不等于**操作系统沙箱。

## 模型与供应商

- 切换模型、选供应商、登录：Pi 原生 `/model` 与 `/login`（列表、搜索、`Enter` 只切当前会话、`Ctrl+S` 设为默认）。
- `sakura models` 查看解析到的模型与凭证状态；`sakura connect` 发一个短请求检查真实连接。
- 默认 `runtime.localOnly: true`，只接受 loopback（本机 Ollama）端点。云端必须用 `sakura --cloud`，或在目标项目 `sakura.config.yaml` 里显式设置：

```yaml
runtime:
  localOnly: false
```

- Sakura 子 Agent 继承当前模型与思考级别，但不会自动获得宿主的 MCP/委托工具。
- 本机 Ollama 常用模型名示例：`sakura init qwen3.5:4b`。

## MCP、扩展包与主题

```bash
sakura mcp add playwright /path/to/config.json   # 或 add NAME -- npx @playwright/mcp
sakura mcp list
sakura install npm:pi-web-access@0.39.0          # 安装 Pi 生态包到 Sakura 独立配置
sakura packages
sakura remove npm:pi-web-access
```

- MCP 走 Pi 原生 `pi-mcp`，配置文件是 `~/.sakura/agent/mcp.json`，不读项目 `.pi/mcp.json`；未配置的服务器不会启动。终端内也可用原生 `/mcp` 管理。
- 第三方 Pi 包都是可执行代码：安装前先确认来源、许可、依赖、网络与文件权限，并注意它是否违反 `localOnly` 策略。

## 网站与工作台

```bash
sakura web                                   # http://127.0.0.1:4317，只监听本机
sakura web --port 4320 --runs /path/to/runs  # 额外读取运行记录目录
npm run site:build                           # 静态导出到 .sakura/site-dist，可单独部署
```

- `/` 是项目介绍网站，`/guide.html` 是使用指南，`/workbench` 是**只读**运行工作台（真实任务、Agent、历史、diff、验证、经验），支持历史搜索。
- 静态导出不含工作台，不需要 Agent 进程、模型或后端。

## 工程流程

1. `plan` / `/plan`：分析任务 → 生成 Task DAG（依赖、写范围、验证点）→ 保存为 `.sakura/plans/<planId>/v1.json`。
2. `run` / `/subagent`：调度器按依赖与写范围决定串行或并行；需要隔离的写任务在独立 Git worktree 中执行。
3. 验证：优先使用 `sakura.config.yaml` 的 `verification.commands`；否则按锁文件探测 npm/pnpm/yarn/bun/Python/Make/Cargo/Go 命令。只读审查还会检查 diff 内容。
4. 交付：产物保存为 diff/artifact 与报告，**不会自动合并或推送**；用 `diff` 预览，用 `apply [--files]` 选择文件并复验，用 `undo` 撤销代码检查点。
5. 记录：事件、指标、上下文包、经验与 diff 都落在 `.sakura/` 下，可追溯；`resume` 恢复未完成节点。
6. 复现：十项固定任务 + 冻结检查在 `benchmarks/`；结果与边界见 [完成度审计](docs/完成度审计.md)。

## 开发

```bash
npm ci --ignore-scripts     # 安装依赖（也用于修好被别的 npm install 改过的 node_modules）
npm run check               # tsc --noEmit + 全部单元/集成测试
npm run check:plugin        # 6 扩展 / 6 工具 / 5 技能 / 2 提示词 体检
npm run typecheck           # 只做类型检查
npm run test                # 只跑测试
npm run dev -- --help       # 直接跑业务 CLI
npm run start               # 不安装，直接启动终端

npm run pack                # 生成 ./sakura.tgz 并打印 SHA-256
npm run release             # 生成发布工件：sakura.tgz + SHA256SUMS + install.sh + release-notes.md
npm run release -- --publish  # 用 gh 创建 GitHub Release（需先 gh auth login）
npm run app                 # 打包 + 全局安装
npm run check:pi-update -- --version latest     # Pi 升级候选检查
npm run check:install       # 临时宿主原生安装验收（Pi 宿主模式）
npm run check:standalone    # 只安装 Sakura 的干净环境验收（初始化/doctor/plan/web）
npm run site:build          # 静态网站导出
node scripts/check-standalone-terminal.py       # 真实伪终端 40/60/80/120 列检查
```

`npm run check` 里包含真实 Pi 会话与 stdio MCP 用例；受保护技能回放需要可用的系统沙箱，不支持的宿主会失败关闭（不是跳过）。Pi 升级流程见 [UPSTREAM.md](docs/UPSTREAM.md)。

## 打包与发布

- `npm run pack` / `npm run app` 输出仓库根目录的 `sakura.tgz`，并打印 SHA-256。
- 包内容由 `package.json` 的 `files` 白名单决定：`extensions`、`skills`、`prompts`、`src`、`docs`、`themes`、`bin`、`web`、`README.md`、`LICENSE`、`THIRD_PARTY_NOTICES.md` 与选定的评测报告；测试、脚本、benchmarks 运行器、`node_modules` 不打包。
- 运行依赖（官方 Pi 包 + TypeScript 加载器）随包安装并锁定版本，因此宿主不需要预装 Pi。
- 发布到 npm 之前，`package.json` 是 `private`；一行安装走 GitHub Release（见上方 curl 安装）。
- 当前是**本地个人版**：未发布到 npm，也没有远端 CI 运行记录。发布前请按 [RELEASE.md](docs/RELEASE.md) 跑完整验收并核对 SHA-256 回执。

## 卸载

```bash
npm rm -g sakura-coding-agent     # 移除命令
rm -rf ~/.sakura                  # 移除独立配置、会话与运行记录（可选）
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `配置 Sakura 本地模型：sakura init MODEL…` | 没有可用的 loopback 模型：先 `sakura init`，或云端用 `sakura --cloud` 后 `/login` |
| `Cloud connection requires --cloud …` | `runtime.localOnly: true` 拒绝了非本机端点：用 `--cloud` 或显式改 `sakura.config.yaml` |
| `sh: tsc: command not found` / 依赖报错 | `node_modules` 被别的 `npm install` 改过（常见于在源码目录里跑 Agent）：`npm ci --ignore-scripts` 重建 |
| `check` 中沙箱用例失败 | 宿主不支持所需沙箱能力，检查按「失败关闭」处理；`bubblewrap` 旧版会拒绝 `clone3` 并让部分命令返回 EACCES，依赖这类调用的验证命令会失败 |
| `doctor` 报 MCP 配置错误 | 检查 `~/.sakura/agent/mcp.json` 与 `sakura mcp list`；未配置的服务器不会启动 |
| 工具缺失提示 | 安装 `fd` 与 `rg`，或用 `--offline` 让 `init` 跳过探测（Sakura 会降级到内置工具） |
| 模型连不上 | `sakura connect` 看真实错误；Ollama 未运行、模型名不匹配或凭证过期都会在这里暴露 |

## 已知边界

- 权限策略不防御宿主 root、任意同 UID 未隔离进程或恶意同进程扩展；这是策略隔离，不是完整虚拟机边界。
- Repo Intelligence 的引用/调用图集中在 TS/JS；Python 只提供定义与相对导入（不执行仓库源码），其他语言走 `read`/`grep` 或显式 MCP 语言服务。
- `/undo` 只覆盖 Sakura 自己保存的代码检查点（原生 write/edit 触及的路径），不覆盖任意 Shell/MCP 的副作用。
- Token/费用预算有在途超出量，不是绝不超支的金额锁。
- 评测结论只对固定模型（Qwen3.5 4B）、固定机器与固定任务集成立：完整矩阵 240 项 153 通过；候选技能因回归被拒绝晋升。详见 [完成度审计](docs/完成度审计.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [开发计划](docs/开发计划.md) | 产品目标、代码现状、技术边界、里程碑 |
| [任务清单](docs/任务清单.md) | 按依赖排序的任务、实现位置、验收条件 |
| [完成度审计](docs/完成度审计.md) | 各模块实际完成度、证据与已知缺口 |
| [实施记录](docs/实施记录.md) | 逐轮修改、检查证据与当时状态 |
| [UPSTREAM](docs/UPSTREAM.md) | Pi 基线、依赖解析、升级 runbook、合同覆盖 |
| [STANDALONE](docs/STANDALONE.md) | 独立入口的安装、启动与隔离细节 |
| [RELEASE](docs/RELEASE.md) | 本地个人版验收与打包发布 |
| [DEVELOPMENT](docs/DEVELOPMENT.md) | 开发环境与目录边界 |
| [CODING_CAPABILITIES](docs/CODING_CAPABILITIES.md) / [FEATURE_GAPS](docs/FEATURE_GAPS.md) | 已补齐能力与剩余差距 |
| [SKILL_SECURITY](docs/SKILL_SECURITY.md) | 技能发布安全合同 |
| [PLUGIN-GUIDE](docs/PLUGIN-GUIDE.md) | 写自己的 Pi 插件/包 |
| [FRONTEND_DESIGN](docs/FRONTEND_DESIGN.md) / [樱花风格规范](docs/樱花风格规范.md) | 界面与配色规范 |
| [架构与开发路线](docs/架构与开发路线.md) / [Pi 复用指南](docs/Pi复用指南.md) | 设计依据（历史文档） |

## 许可

MIT。Pi 及其官方包的相关声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [LICENSE](LICENSE)。
