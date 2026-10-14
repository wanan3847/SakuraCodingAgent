# Sakura 开发说明

## 环境与仓库边界

仓库根目录**就是** npm package 根目录：`package.json`、`src/`、`extensions/`、`bin/`、`web/`、`tests/`、`themes/`、`skills/`、`prompts/`、`templates/`、`benchmarks/` 都在根下。`docs/` 放计划、状态与设计依据，`scripts/` 放打包/检查脚本，`.github/` 是兼容 CI。运行数据、评测产物与本地安装收据存入忽略的 `.sakura/`，`node_modules/` 与 `*.tgz` 不发布。第三方研究检出（旧 `ref/`、`vendor/`）与迁移备份已清理，需要对照时按上游 tag/commit 重新检出。

```bash
npm ci --ignore-scripts
npm run check
npm run check:plugin
```

Pi 基线为官方 `1.1.0`，Node >=22.19，当前开发环境 Node 26.10/npm 11.19。默认检查不依赖用户凭证、不调用真实模型；SDK 合同通过注册脚本 provider 运行真实 Pi Session、工具和落盘。模型端到端检查另行记录。

在 Pi 里调试本包（可选，需要同版本 1.1.0 宿主），用 `npm exec -- pi install -l "$PWD"` 加载 manifest。在目标项目只需安装这个本地 package，沿用原生 CLI 参数。不要复制一个 CLI parser。

## 边界

Pi 负责 Agent Loop、模型与鉴权、Session、流式事件、工具、compaction、Skills 和 TUI。Sakura 负责工程 TaskGraph、调度、Git 工作区、验证证据、经验选择。`src/runtime/` 仅做角色/cwd/tools 接线；没有第二个 Runtime，不增加 Adapter 链、独立 Tool Registry 或模型配置。

| 代码位置 | 职责 |
| --- | --- |
| `src/planning/` | 任务分析、计划与 DAG 校验 |
| `src/orchestrator/` | 角色、依赖调度与独立委托 |
| `src/repo-intelligence/` | TS/JS AST、符号/导入/测试关系与检索 |
| `src/workspace/` | worktree、策略、产物快照 |
| `src/experience/` | 事实抽取、存储与检索 |
| `src/verification/` | 项目命令探测、执行和证据 |
| `src/telemetry/` | 事件、metrics、trace |
| `src/runtime/` | 官方 Pi SDK 接线、角色指令、结构化 run state |
| `extensions/` | Pi 工具/命令及必要 UI 钩子 |

CLI 和扩展共用 `src/run.ts`，业务逻辑放 `src/`，公开业务导出显式列在 `src/index.ts`。

## 关键约束

- 角色指令通过原生 ResourceLoader 进入 system prompt；子会话禁用自动 extensions，只开显式工具。只读角色没有 shell。
- provider 失败可能表现为 assistant stopReason:error，不能仅凭 prompt resolve 判断成功。写任务零改动或无法收集改动也不能视为成功。
- 完整 Git 产物通过临时 index 收集，包含新增、删除、重命名和 binary，不修改用户 staging。产物保存成功之后才能清理 worktree；保存失败保留路径并报告。
- metrics 来自事件；未知 usage 不能在展示中伪装为 0。合同变更需要检查外层/子会话是否重复计数。
- worktree 只隔离文件。策略钩子不能声明为容器或 OS 沙箱。
- Repo 查询含 IMPORTS/TESTS/REFERENCES/CALLS；TypeScript checker 做跨文件解析，内容哈希缓存复用未变文件，并由全局 program 重连引用。动态调用与其他语言仍由原生读取/搜索工具处理。
- 原始参考设计保留，但进度以根目录任务清单和实测证据为准。旧 `PLUGIN-GUIDE.md` 中历史 Pi 版本示例应对照当前公开类型，不作为现版 API 真源。

## 上游更新

见 [UPSTREAM.md](UPSTREAM.md)。当前没有 `pi-core/`、手写 ExtensionAPI 类型、类型错误白名单或源码同步脚本。需要尚未发布修复时使用原样上游检出及官方构建，在候选中验证后采用。
