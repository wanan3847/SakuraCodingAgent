# 复用 / 包装 / 参考 / 自研 决策记录

对应复用指南 §15 的 Reuse Check。每加一个依赖或新模块都往这里追加一行，不改历史行。

**当前目标决策见 ADR-003（2026-10-12）：优先官方包/原样源码构建、容易同步与最小接线。** ADR-001/002 和历史表格解释当前实现；官方包迁移尚未执行。

## 决策

| 能力 | 决定 | 依据 |
|---|---|---|
| 模型调用、Agent Loop、Session、Streaming、compaction | **拷贝 Pi 核心源码**（`pi-core/`，539 文件） | 用户明确要求“核心源码进项目、手工合无所谓”；这覆盖了复用指南 §12 的默认禁止项，因此记录在此 |
| `read/write/edit/bash/grep/find/ls` | 复用 Pi | 不复制工具 schema 和执行器 |
| MCP | 复用 `vendor/pi-mcp-adapter` | 协议和 transport 不值得重写（P2） |
| Subagent 启动 / 多 Agent 委托 | 包装 `vendor/pi-subagents` | 复用其启动、生命周期、workflow 能力；调度策略仍由 Sakura 定 |
| Skills 发现与加载 | 复用 Pi Resource Loader，Sakura 只加 Router | 不换一种 Markdown 格式重实现 Skill 系统 |
| Task DAG / 依赖校验 / 调度 / Replanning | 自研 | 五个核心卖点之一，进 Benchmark |
| 命令探测 + 验证证据 | 自研 | 公共闭环能力，不是第六个创新模块 |
| Repo symbol graph | 自研（未做） | 差异化能力；第一版只做加权检索 |
| Git worktree 隔离 | 自研 | 直接调 git，不引第三方 workspace 框架 |
| Experience / Skill 晋升 | 自研（未做） | 必须走 candidate → eval → review → promoted |

## ADR-001：把 Pi 核心源码拷进项目（覆盖复用指南 §12 默认禁止）

- **缺失能力**：无。Pi 公开 SDK 完全够用；本决策是部署形态选择，不是能力缺口。
- **已尝试的公开扩展点**：SDK + 相对路径引用（`../../../pi/packages/...`）——能跑，但那仍然是“仓库外的一棵树”，用户要求变成项目内容。
- **为什么不用集成层解决**：集成层解决接口隔离，不解决“源码归属”。
- **范围**：只拷**文件闭包**（从 `createAgentSession` 出发的 539 个文件），不是整个 30M monorepo；`server/ evals/ session-backends/ cli/ modes/ experimental/` 未拷。
- **合并方式**：`scripts/sync-pi-core.mjs` —— 重算闭包 + 把 `@earendil-works/*` 改写为相对路径 + 再生成 `pi-core/index.ts`。上游升级重跑脚本即可，冲突点集中在重写规则与 `EXTERNAL_DEPS.json`。
- **已知代价**：26 个第三方 npm 依赖要装（98M node_modules）；2 条上游类型错误用白名单放行（`scripts/typecheck.mjs`）；`pi-core/` 里的手改会被下次同步覆盖。
- **移除条件**：需要在多 Runtime 之间切换，或 Pi 发布可直接引用的版本时，重新回到「依赖已发布包」。
- **验证**：`tests/integration/pi-core.test.ts` 从 `pi-core` 起了一个无头 `AgentSession`（不调模型、不需 API key）。

## 未采用的候选（避免以后重复讨论）

| 候选 | 不用的原因 |
|---|---|
| `AgentRuntimePort → PiAdapter → Pi SDK` 抽象链 | 当前只有一个 Runtime，是人为复杂度；第二种 Runtime 真出现再抽 |
| 向量库 / embedding 检索 | 架构文档 §9.4 明确第一版不上 |
| 自研 TUI / Web UI / 容器级 Sandbox | 架构文档 §30 明确不做 |
| 复制社区扩展源码进 Sakura | 升级和许可证都会失控；要改就提上游或记 ADR |

## Pi 升级合同测试（待补，Phase 0 收尾）

创建 session → 发 prompt → 收流式事件 → 只读工具 → 临时仓库里写工具 → cancel → steer → 持久化+恢复 → compaction → 取 usage。
未通过不允许更新 lockfile。

## 决策（插件化 / 打包阶段，追加）

| 能力 | 决定 | 依据 |
|---|---|---|
| 五个自研模块的对外暴露形式 | **一个模块一个插件**（6 个 `extensions/sakura-*.ts`），不带转发层 | 模块数≠插件数，但拆开的实际收益是能用 `pi config` 逐个开关，代价是 N 倍手工一致性。折中：接受这个代价，并用 `scripts/check-plugin.mjs` 把"漏 `export default` / manifest 路径 / 跨文件工具名重名"变成静态可查。不做 `src/surfaces/` 中间层——插件文件本身就是那一层 |
| 扩展的类型来源 | `types/pi-extension.d.ts` 手写最小子集 | `@earendil-works/pi-coding-agent` 的 types 指向未 build 的 `dist/`；不为此让「先构建 Pi」成为 typecheck 前置 |
| 扩展的运行时依赖 | 走 `pi-core/`（vendored 源码），**不** import 包名 | ADR-001。代价是宿主 Pi 与 pi-core 在进程内各一份 runtime，已知且记录在 README |
| `Verification` 的形态 | `sakura_run` 内部的公共闭环 + `sakura verify` 命令，**不做第六个插件** | 架构路线 §17 / [Pi 复用指南](Pi复用指南.md) §17 |
| Skills 数量 | 5 个（planning / systematic-debugging / tdd / code-review / verification） | 架构路线 §14：基础能力，不占主要研发周期 |
| 集成（cherry-pick / merge） | 不做，跑完只留 diff | 架构路线 §11.2 把它列为 P1；不假装自动合并是安全的 |
| Repo Intelligence 的边 | 第一版只做 IMPORTS（文件级）+ TESTS（文件名约定） | 架构路线 §29 风险 1 的降级路径 |
| 经验写入时机 | 只在验证闭环跑完之后由 `run.ts` 写 | 架构路线 §15：Trace → Experience，不允许模型自动改正式 Skill |

### 实测踩到的假成功（已修在根因处）

Pi 的 `AgentSession.prompt()` 在 provider 报错时**不会 reject**：它把错误写进 assistant 消息的
`stopReason: "error"` + `errorMessage`，content 为空。第一版 `pi-agent-runner` 只看
「promise 没 reject」，于是把一次 `Connection error` 报成任务成功，整轮 `completed: true`
且 `diff: 无改动`。

修在 `runtime/pi-agent-runner.ts` 的 `verdictOf()`，三条规则一次判掉（纯函数，有单测）：
provider 报错 → failure；拿不到 changedFiles（git 不可用）→ failure；写角色改了 0 个文件 → failure。

## ADR-002：删掉本地 Pi 源码树（`../pi`）

- **背景**：ADR-001 把 Pi 核心源码闭包拷成了 `pi-core/`。那之后 `../pi`（392M 的完整 clone）
  就只剩两个用途：给 `sync-pi-core.mjs` 当拷贝源，以及给 `typecheck.mjs` 借 `tsgo`。
- **决定**：删掉 `../pi`，把这两件事都改成自给自足。
  - `sync-pi-core.mjs` 默认按 `pi-core/README.md` 里记的 commit 浅克隆上游到 `.pi-source/`，
    也支持 `--from=<本地检出>`（有本地检出时最快）和 `--ref=<tag|commit>`。
  - `typecheck.mjs` 改用项目自己的 `typescript`（已在 dependencies 里）。
- **顺带修的一个真问题**：换成 `tsc` 后 `pi-core/tui/utils.ts` 报 6 条 TS1501（正则 `v` flag
  需要 ES2024）。`tsgo` 不报，说明之前那套编译器一直在漏检。`tsconfig.target` 从 ES2022 升到
  ES2024——对齐 Node 22 的实际能力，而不是把 6 条错误塞进白名单。
- **恢复方式**：`git clone https://github.com/earendil-works/pi.git && git -C pi checkout 71dca871`。
  删除前已确认 `pi/` 是干净的 clone：无本地独有 commit，唯一工作区改动是一个无关的 `.pi/extensions/audit.ts`。
- **验证**：`npm run check` 全绿（58 用例 + 类型门禁），并实测 `pi -e <包目录>` 能加载 5 个插件、
  跑通 `sakura_run`（worktree + 验证 + diff 全链路）。

## ADR-003：优先上游同步，直接使用官方 Pi 包与公开类型

- **状态**：目标方案已确定，迁移待实施；见根目录 `docs/任务清单.md` 的 S0-06/07。
- **依据**：用户于 2026-10-12 要求 Pi 上游更新可同步或快速跟进，减少不必要包装和复杂性。此要求更新 ADR-001 中接受手工同步成本的取舍。
- **当前成本**：`pi-core/` 复制文件闭包并重写包名导入；另有手写 ExtensionAPI、第三方依赖清单与上游类型错误白名单。宿主 Pi 和内嵌副本分别维护 runtime。更新容易受内部目录与生成数据变化影响。
- **决策**：默认精确锁定官方 Pi 包，直接 import 公开导出与类型。交互、资源加载和模型配置使用 Pi CLI；Sakura 保留工程任务逻辑和必要 SDK 接线。
- **源码跟进**：源码可原样检出在独立目录，固定 tag/commit，沿该版本上游构建。未发布改动也通过官方包名与构建产物接入；不复制闭包或改写 import。源码保持无 Sakura 业务修改。
- **单一运行依赖**：宿主与 SDK 使用同一份 Pi 包；开发/评测锁版本，发布兼容区间依据实测确定。依赖解析与构建由包管理器和上游流程承担。
- **减少包装**：不维护通用 Runtime Port/Adapter、复制完整事件协议或 Tool Registry。业务 AgentRunner 可保留调度与结果判定；Pi 已提供的参数、模型选择、鉴权、会话界面直接使用。扩展入口按需要独立加载的行为划分。
- **升级**：上游 release 形成候选版本更新，在隔离工作区检查后接受；main 跟进按需固定具体 commit。更新记录包含版本、来源、检查结果、耗时与 Sakura 改动点。失败保留当前可用版本。
- **迁移退出项**：`pi-core/`、复制重写脚本、手写 Pi API 类型和对应类型白名单；清理不再直接使用的依赖及未使用 vendor。实际迁移完成后更新所有开发/安装说明。
- **过渡风险**：当前同步脚本在 unresolved 导入检查前就写目标；在旧同步路径仍会使用时先将验证前置、候选生成移到临时目录，避免升级失败破坏当前副本。
- **历史关系**：取代 ADR-001 的长期源码闭包部署目标，并更新 ADR-002 关于源码检出的用途；历史内容保留供追溯。
- **验收**：官方包加载现有业务流程，Pi 原生类型检查通过，工具权限/usage/cancel/恢复合同可用；一次实际版本升级及失败回退可复现。迁移验收前不宣称这些能力已完成。

## ADR-004：独立配置与公开 SDK 终端

用户于 2026-10-13 明确要求 Sakura 可单独使用，并与本地 Pi 隔离。此要求更新 ADR-003 中仅使用共享 Pi CLI 的交互取舍，继续保留官方公开 SDK、原生会话与终端，不复制或改写上游源码。

新增 `sakura` 薄启动入口：SDK 导入前绑定独立 agentDir/settings scope；只显式加载自身扩展、技能、提示与主题。公开 InteractiveMode/Session Runtime 负责终端和会话；品牌标题、进度与底栏由扩展设置。SDK、typebox 和 jiti 是独立应用的固定运行依赖，干净宿主只安装 Sakura 即可启动。作为外部 Pi package 使用时，应采用同版本 SDK 宿主，异版本须先做兼容验证。

Web 使用本地只读 HTTP 服务和原生浏览器资源，读取已有 checkpoint/events/diff，不复制 Agent 调度或添加云追踪前置依赖。配置隔离与操作系统执行保护是两种边界，分别验证。
