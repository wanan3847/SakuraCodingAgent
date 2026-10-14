# Sakura 评测

`tasks/` 包含十个固定 Git 任务，覆盖 token 修复、新文件、重构、只读审查、依赖协作、重复问题及恢复场景。JSON 为执行入口，`auth-refresh.yaml` 是同一任务的格式示例。所有任务从 `fixtures/token-refresh.bundle` 的确切 commit 创建独立仓库，无需在线克隆。

每个任务同时执行项目命令和仓库外冻结的类型/场景检查。模型修改 package scripts、测试或 tsconfig 不会改变冻结判定器。只读审查还需无 diff，且最终回答包含问题与位置。

```bash
node scripts/prepare-benchmark-fixtures.mjs
node benchmarks/runners/run.ts --dry-run
```

三组基线为 `pi`、`pi-community` 和 `sakura`。社区基线使用原样 `pi-subagents@0.62.0`，默认位置为 `.sakura/benchmark-plugin/node_modules/pi-subagents`，可用 `--community-path` 指定。消融为 `no-multi`、`no-repo`、`no-worktree`、`no-experience` 和 `fixed-plan`。

`no-multi` 先使用相同的动态 Planner，再把职责、范围和验证合并为一个执行节点；`fixed-plan` 单独关闭模型规划，使用确定性 Planner。避免同时关闭两个模块而混淆收益。

同一矩阵固定模型、thinking、采样设置、工具集合、基础 commit、机器、超时和经验种子。默认十个任务 × 八组 × 三次，共 240 个试验。执行器使用 Pi 配置中的本地模型；`PI_CODING_AGENT_DIR` 指向独立的原生评测配置。

```bash
PI_CODING_AGENT_DIR="$PWD/.sakura/benchmark-agent" \
  node benchmarks/runners/run.ts \
  --model ollama/sakura-bench-qwen35-4b \
  --experience-seed .sakura/benchmarks/experience-seed \
  --total-timeout-ms 43200000 \
  --report .sakura/benchmarks/full-matrix.json

# 仅补齐尚未执行的试验；原有失败/取消仍纳入统计
PI_CODING_AGENT_DIR="$PWD/.sakura/benchmark-agent" \
  node benchmarks/runners/run.ts --resume \
  --model ollama/sakura-bench-qwen35-4b \
  --experience-seed .sakura/benchmarks/experience-seed \
  --total-timeout-ms 43200000 \
  --report .sakura/benchmarks/full-matrix.json
```

每个试验即时保存 `trial.json`、结果补丁、回答和原始运行证据。新报告包含 `sources.tar.gz` 及 SHA256。模型、源码、依赖锁、矩阵或经验种子变化时拒绝恢复到同一报告，必须创建新报告。Ctrl+C/SIGTERM 停止当前任务并保存取消记录；超时记录为 failed/timeout；`complete` 只表示矩阵全部执行，不表示全部成功。

指标包括成功率、验证结果、token、时间、工具/Agent 调用、成功读取的唯一文件、输入 context 峰值、retry/replan、集成冲突和费用来源。`contextTokens` 使用所有会话中 Pi assistant usage 的最大 `input + cacheRead`；Sakura 的 Context Pack 字节上界另记为 `contextPackTokens`。费用未知时保留未知，本地模型零单价不能代表硬件和电费为零。

Files Read 包含仓库索引扫描和选中片段的成功读取，同一逻辑路径去重；不能把自动索引的读取成本省略。retry 按实际重试事件累计，重规划不会清零。

社区子会话指标从最终公开 result details/原生 Session 读取并去重。缺少完整消息、模型切换、多次 provider 尝试或脱离父会话的任务不能证明完整口径，报告标为 `root-only`，不用于完整性能比较。无子会话时主会话即为完整范围。

经验对照须检查 `experienceSources` 和原始 Context Pack，证明确实注入了可追溯的经验。无命中不阻断任务，但不能当作检索收益试验。失败照常纳入统计，样本不足时不给收益结论。

已完成的六次来源核对及局限见 [经验对照](reports/experience-2026-10-13/README.md)。

个人版真实编码产物见 [发布审计](reports/release-2026-10-13/README.md)。重放验收：

```bash
node benchmarks/runners/audit-release.ts
```

候选技能通过 `replay-candidate.ts` 创建独立固定任务仓库，绑定完整工件并执行受保护真实模型与冻结检查。它只推进到 `evaluated`，新报告为 `.sakura/release/candidate-review-v2.json`。

`scripts/evaluate-candidate-pairs.ts` 执行三任务各三对的基线/候选对照，共 18 次，原始回执和进度位于 `.sakura/release/candidate-effect-experiment/`。默认不批准；明确 `--user-authorized` 且可信效果门槛通过才批准并晋升。权威审批在工作区外，运行必须使用独立 worktree 和 macOS 沙箱。详见 [安全合同](../docs/SKILL_SECURITY.md)。

```bash
PI_CODING_AGENT_DIR="$PWD/.sakura/benchmark-agent" \
  node scripts/evaluate-candidate-pairs.ts --user-authorized \
  --after-report .sakura/benchmarks/full-matrix-2026-10-13-v2.json --after-pid <known-live-pid>
```

排队期间源代码改变或前序进程停止而矩阵未完成时停止；已存在证据拒绝覆盖，可用 `--output <new-directory>` 创建新实验。完整矩阵 v2 评估加固前的冻结源码，不能直接替代加固后的候选效果对照。
