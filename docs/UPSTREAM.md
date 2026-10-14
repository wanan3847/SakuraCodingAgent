# Pi 基线与上游更新

Sakura 是 Pi 之上的产品层：模型调用、Agent Loop、会话、工具、终端 UI、资源（扩展/技能/提示/主题）和 MCP 都走官方包，Sakura 只实现规划、调度、工作区、验证与经验。所以「升级 Pi」= 换依赖版本 + 跑一遍兼容检查，不需要改业务代码，也不需要 fork。

## 1. 基线与来源

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | `1.1.0` | SDK、Session、ResourceLoader、SettingsManager、InteractiveMode |
| `@earendil-works/pi-ai` | `1.1.0` | 模型类型与 provider 层（`@earendil-works/pi-ai/compat`） |
| `@earendil-works/pi-tui` | `1.1.0` | 终端渲染原语（截断、可见宽度、组件基类） |
| `@earendil-works/pi-codemode` | `1.1.0` | codemode 扩展工厂；版本敏感，见第 2 节 |

- 上游仓库：`earendil-works/pi`，基线 tag `v1.1.0`，commit `abe508e1b89912adde45528136c3221eb69acdd7`。
- 精确版本与许可、兼容结论记录在 [pi-compatibility.json](pi-compatibility.json)；本文件解释规则与流程。
- 业务代码只 `import` 上述包的公开导出，没有引用 Pi 源码内部路径，也没有手写 Pi 类型声明。
- Pi 的 `peerDependencies` 写成 `*` 表示「由宿主提供同一份模块」的加载方式，**不代表任意版本都通过验收**。实际兼容范围只以候选报告和兼容记录为准。
- 子会话与主会话从同一个安装解析官方包；Sakura 不内嵌 Pi runtime，也不打包 Pi 源码副本。

## 2. 依赖解析与 `pi-codemode` 锁定

`package.json` 把四个包都写成精确版本，`package-lock.json` 固定整棵依赖树。安装后解析结果应满足：

```bash
cat node_modules/@earendil-works/pi-coding-agent/package.json | grep '"version"'
npm ls @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui @earendil-works/pi-codemode
```

已知的上游边界：Pi 1.1.0 对 `pi-codemode` 声明的是 `^1.1.0`。一次全新的全局宿主机安装解析到后续版本时，实测 CLI 启动会因为缺少 `MCP_TYPESCRIPT_PREAMBLE` 导出而失败。因此：

- 仓库 `npm ci` 按锁文件安装 `1.1.0`，不受影响。
- `npm run check:install`、`node scripts/check-installed-package.mjs`、`scripts/check-short-install.mjs` 这类在临时宿主里做**原生安装**的检查，会显式钉住 `pi-codemode@1.1.0` 并记录这一点。
- 升级 Pi 时必须先撤掉这个临时限制跑候选，并记录上游是否已修复；不能把「受限制的 1.1.0 安装通过」当成「任意宿主版本都可用」。

## 3. 兼容记录（pi-compatibility.json）

记录字段与含义：

| 字段 | 含义 |
| --- | --- |
| `pi` / `packages` | 已验收的官方包版本 |
| `source` | 上游 tag 与 commit，便于按 commit 原样检出对照 |
| `checks` | 通过检查的清单（类型、测试、插件体检、CLI、打包、安装） |
| `contracts` | 明确覆盖的 Pi 合同，见第 8 节 |
| `notes` / `knownIssues` | 已知边界与临时限制（例如 `pi-codemode` 钉版本） |

只要出现下列任一情况就必须更新本文件与记录：接受新版本、拒绝某版本（记原因）、上游修掉已知边界、合同覆盖范围变化。

## 4. 常规升级流程

### 4.1 记录当前状态

```bash
shasum -a 256 package.json package-lock.json
```

`check:pi-update` 会核对这两个文件在候选检查期间没有被改动；改动过就无法用它证明「候选失败不影响当前版本」。

### 4.2 跑候选检查

```bash
npm run check:pi-update -- --version latest --report .sakura/upgrades/candidate.json
npm run check:pi-update -- --version 1.1.0                  # 指定版本
```

脚本把业务源码复制到临时目录，用同版官方包安装，然后依次跑：

1. TypeScript 类型检查；
2. 全部单元/集成测试（离线、脚本模型 provider 替身）；
3. 插件体检（扩展、工具、技能、提示词计数与重名检查）；
4. Pi CLI 版本与原生 package 加载；
5. 打包检查。

期间不修改工作目录的 `package.json` / `package-lock.json`；报告写到 `--report` 指定的路径（默认在 `.sakura/upgrades/`）。未知适配文件记 `null`，不当成通过。

### 4.3 判定与采用

全绿才采用，然后：

```bash
npm install --ignore-scripts --save-exact \
  @earendil-works/pi-coding-agent@<version> \
  @earendil-works/pi-ai@<version> \
  @earendil-works/pi-tui@<version>
npm run check            # 类型检查 + 全部测试
npm run check:plugin     # 插件体检
npm run check:install    # 临时宿主原生安装
npm run check:pi-update -- --version <version>   # 记录候选结果
```

最后更新 [pi-compatibility.json](pi-compatibility.json) 与本文件：版本、commit、检查结果、耗时、是否引入临时限制。普通兼容升级只需改 `package.json` / `package-lock.json` / 记录三处；如果业务代码需要跟着改，说明这次不是普通兼容升级，要在记录里写清动了哪些文件、为什么。

### 4.4 失败与回滚

- 候选失败：删除临时目录，当前依赖不变，把失败原因写进报告，不合并。
- 采用后回归：恢复切换前的 `package.json` 与 `package-lock.json`，执行 `npm ci --ignore-scripts`，再跑 `npm run check`。
- 已演练过的结论：1.1.0 通过、0.99.2 通过、0.85.1 因类型失败被拒绝；从旧内嵌源码迁到官方 1.1.0 涉及业务接线，属于非普通升级。

### 4.5 不要做的事

- 不要把 Pi 源码复制进仓库或改写内部文件；需要未发布修复时按第 5 节处理。
- 不要用改动忽略清单、放宽 `tsconfig`、跳过测试来「让候选通过」。
- 不要只在新版本上跑一次真实模型任务就宣布兼容；模型质量不是兼容性证据。
- 不要把 `peer: "*"` 写成发布事实：当前 `package.json` 是 `private`，没有 `peerDependencies`。

## 5. 未发布源码（需要 main 上的修复时）

1. 在临时目录原样检出目标 commit，不改文件；
2. 按该 commit 的官方 README 构建、打包；
3. 用**官方包名**把构建产物接进候选检查（第 4.2 节），记录 commit 与生成产物的摘要；
4. 验收通过才更新依赖，并在兼容记录里写明「基于 commit 而非发布版本」。

本仓不保留第三方或上游源码副本：旧的 `vendor/`、`ref/` 研究检出、`.sakura/migration-backup/` 均已清理，需要对照时按 tag/commit 重新检出。

## 6. 持续集成

[.github/workflows/pi-compatibility.yml](../.github/workflows/pi-compatibility.yml)：

- 触发：push / PR（忽略 `docs/**`、`**/*.md`、`.sakura/**`）、每日定时、手动；
- 跑：`npm ci --ignore-scripts` → `npm run check` → `npm run check:plugin`；
- 定时/手动任务额外跑 `npm run check:pi-update --version "${{ inputs.version || 'latest' }}"` 并上传候选报告为 artifact；
- 只在 `macos-latest` 上跑，因为受保护技能回放依赖系统沙箱，不支持的宿主失败关闭（fail closed）；
- 不自动发布、不自动合并候选。

该工作流需要仓库推到 GitHub 后才会实际运行；当前仓库没有远端，所以不能声称 GitHub CI 已经跑过。

## 7. 公开 API 与权限边界

| 采用能力 | 官方公开入口 | Sakura 接线 |
| --- | --- | --- |
| 会话与模型 | `createAgentSession`、`ModelRuntime`、`SettingsManager`、`SessionManager` | 角色/cwd/工具白名单、本地端点限制、原生会话文件引用 |
| 资源与角色指令 | `DefaultResourceLoader`、`appendSystemPrompt`、`extensionFactories` | 子会话禁用自动扩展/提示模板/技能；技能正文经 Context Pack 选择 |
| 取消/补充/压缩 | `AgentSession.abort` / `steer` / `followUp` / `compact` | 整轮信号、定向业务信箱；历史压缩继续交给 Pi |
| 工具/流/usage | `subscribe`、`customTools`、公开消息事件 | 事实计数、provider 错误判定、`submit_plan` |
| 品牌入口 | Pi manifest、`ExtensionAPI`、原生 themes、`pi-tui` 截断 | 业务阶段 widget；目录、模型、上下文、模型切换保留 Pi 原生 UI |

- 子会话禁用自动 Extension 发现，只启用显式角色白名单与 `customTools`；不继承宿主委托/MCP 工具，角色 system prompt 通过 ResourceLoader 注入。
- 只读角色没有 `bash`、`powershell`、`write`、`edit`；配置覆盖拒绝通配符和追加默认工具语法。
- 显式 `customTools` 的实现由调用方负责，名字白名单不能约束其内部文件/网络行为。
- worktree 隔离文件副本，策略钩子检查路径与 symlink。shell 拥有宿主进程权限，需要明确审批；无 UI 时不自动授权。`policy.network: deny` 阻止无法约束网络的任意 shell；`allow` 允许项目定义的验证命令，仍按危险动作规则处理。这不是 OS/容器沙箱；`runtime.localOnly` 只限制模型端点为 loopback，不代表所有工具离线。

## 8. 合同覆盖与不验证的范围

**覆盖**（由测试与真实会话检查）：会话创建、原生模型配置、prompt、流式事件、真实读写工具、cancel、steer、follow-up、持久会话恢复、原生 compaction、usage、package/theme 加载。

**不覆盖**：真实模型质量与稳定性、付费 provider 的鉴权行为、费用准确性、上游未公开的内部路径、宿主 root 与同 UID 未隔离进程的防御。

## 9. 历史

- ADR-001：早期把 Pi 核心源码拷进项目（`pi-core/`，539 文件），现已退出运行路径，复制文件与手写声明已清理，回退改为按 tag/commit 重新检出。
- ADR-002 / ADR-003：目标接入方式从「源码副本 + 手写类型」收敛为「官方包 + 公开类型」，必要时按 commit 原样检出上游源码构建。取舍记录见 [reuse-decisions.md](reuse-decisions.md)。
- 旧源码基线 `71dca871bc80b6bc97be37f0ca3189399d651fff` 的迁移备份 `.sakura/migration-backup/` 已随仓库整理清理。
