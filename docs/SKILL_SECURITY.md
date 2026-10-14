# 技能候选的可信发布边界

2026-10-13。本系统是带证据与审批的技能候选发布系统。一次任务通过只证明候选参与了该次成功运行；效果改善需要同设置重复对照，局部改善不能推断通用进化收益。

## 工件与运行证据

`sha256` 现在覆盖统一 `renderSkill()` 生成的整个 SKILL.md，包括 name、description、body。它不再是正文哈希。加载器从同一次读取的字节生成工件哈希和注入正文，记录规范来源路径、名称、参考块与是否完整进入 Context Pack。预算截断不能用于候选验收。

宿主运行时在原生 Pi 执行和验证完成后，在工作区外记录运行回执，绑定项目、runId、规范 runDir、模型/设置、技能工件、state/Context Pack 哈希及真实指标。`evaluateCandidate` 只接受该回执，精确匹配候选的 replay-vN 路径与完整工件哈希。另一技能包含相同正文、旧版本或其他项目的运行均不能代替此版本。此证据证明正确版本进入任务上下文，不证明模型遵守了每条指令。

旧实现的候选 JSON 与历史运行没有这套权威回执，不能直接导入为已审阅、已晋升状态；须重新提议并回放。历史证据保留，不伪造新的认证记录。

## 权威记录与执行权限

默认权威目录为 `~/.sakura-control-credentials/`，必须在 Agent 工作区之外、由当前操作系统用户拥有、权限为 0700，并拒绝目录 symlink。每个规范项目路径对应独立 ledger。项目 `.sakura/skill-candidates/` 的 latest/vN/active JSON 只是展示镜像；改这些文件不能获得发布权限。发现与权威记录不一致时拒绝操作。

`--control-dir <external-directory>` 是可信操作者的 CLI 参数，不从模型可写的项目配置读取。运行、评测、审查、晋升和查询必须使用同一权威目录；临时测试目录不是持久生产存储。

候选回放和显式保护对照必须在独立 Git worktree 执行，原地模式或 worktree 创建失败时拒绝在宿主目录运行。只开放 read/write/edit/grep/find/ls 六种原生工具，禁止任意 shell 和隐式扩展。路径策略无条件拒绝模型访问权威目录，保护 `.sakura` 控制数据和 `.pi/skills`。验证命令另外使用 macOS 系统沙箱：只能写当前 checkout 和独立临时目录，不能改宿主控制代码、审批目录或正式技能，不能读取审批目录，并禁止网络与 Mach 服务访问。冻结判定器同样在此保护下执行。

macOS `sandbox-exec` 后端已通过完整测试。路径规则先解析真实路径及现有祖先，覆盖 `/var` 与 `/private/var` 等别名；验证脚本不能读取权威记录，也不能连接宿主 Unix 服务。

Linux x64/arm64 后端使用固定 `/usr/bin/bwrap`、只读宿主挂载、独立 user/PID/network namespace 和 seccomp。仅当前 checkout 与临时目录可写，权威目录被遮蔽，禁止 socket、socketpair、io_uring、嵌套 namespace 操作和兼容 ABI。seccomp 的嵌套 namespace 限制兼容缺少 `--disable-userns` 的旧 bubblewrap。2026-10-13 在 Alibaba Cloud Linux 3、bubblewrap 0.4.0 上通过 `npm run check`（148/148，0 跳过）、嵌套 user namespace 拒绝探针及受保护候选回放；没有安装或修改 AppArmor。旧版过滤拒绝 `clone3`，探测到某些 Node `spawnSync` 调用会返回 EACCES；依赖此类调用的验证命令失败关闭，需按具体项目确认。验收不防御宿主 root、任意同 UID 未隔离程序或恶意同进程扩展。

兼容 CI 使用 macOS；本机检查通过不等于远端 CI 已运行。这不是对宿主 root、任意同 UID 的未隔离程序或恶意同进程扩展的防御。启用这类能力前必须再使用独立身份/容器或受保护服务；不能仅依赖审核 JSON 或 reviewer 字符串。

`reviewer` 是审计归属标签，不是认证凭据。授权边界是可信操作者控制的目录和进程。`mode=human` 表示操作者显式批准；`mode=user-authorized` 表示用户明确授权的自动流程。后者不能冒充人工逐条审阅，并额外要求效果门槛通过。

## 并发、发布和回滚

全部读取、校验、修订和提交在外部跨进程锁内完成。不会因时间长而删除活进程的锁；死进程锁的回收也有独占保护。缺失 owner 或回收进程自身崩溃时保持关闭，需操作者确认进程死亡后修复孤立锁。

名字在权威 ledger 中预留；另一候选不能使用同名技能。目标目录已存在但不归当前候选所有时拒绝，已归属目标被修改时也拒绝。受管路径禁止 symlink。

发布先写持久事务日志，再替换 SKILL.md，再提交 active/版本状态，最后刷新项目镜像。中途失败保留日志；下一次受控操作在锁内恢复，发现目标被第三方修改时拒绝覆盖。镜像写入失败可由权威状态重建，镜像从不授予审批权限。文件与镜像不是同时可见的多文件原子操作；受控消费者必须通过核对 active 和实际工件的接口读取。

latest 是最新创建的候选版本，active 是实际生效版本；回滚只改变生效版本，保留最新候选。active 始终包含 candidateId/name/version/sha256/path。运行时使用经核对的正式技能，明确回放新修订时优先使用该修订，不同时注入旧版。工件缺失、改写或无可信所有权时拒绝。

## 对照与自动批准

可信对照接收运行 ID，不接收调用者填写的成功率或 token 数。两组使用同一任务/base、模型、设置、工具和 OS 保护；基线不得选中候选，有候选组必须完整选中精确工件。冻结检查回执只能使原生失败保持失败，不能把失败改成成功。全部失败尝试保留。

自动批准条件：至少两个任务、每个三对；所有候选尝试通过；总 token 与工具调用均不增加；通过数/token/工具至少一项严格改善。耗时另行报告。它是保守的本地发布门槛，不是统计显著性或通用收益证明。指标不足、候选退化或样本不足时保留 evaluated，不自动发布。

本轮真实实验使用 auth-refresh、repeated-refresh、expiry-boundary 三个固定任务各三对，共 18 次；经验检索在两组均关闭，隔离候选技能的影响。用户已明确授权符合门槛后的自动批准，记录为 user-authorized。最新实验在 macOS 独立运行，完整 240 项矩阵在 work 使用同型号本地模型运行；两台主机的报告分别保留，不拼接为同一硬件的结果。

## 操作

```bash
node src/cli/dev.ts candidate propose candidate.json
node src/cli/dev.ts run "refresh token regression" --candidate <id>
node src/cli/dev.ts candidate evaluate <id> .sakura/runs/<runId>
node src/cli/dev.ts candidate assess <id> pairs.json
node src/cli/dev.ts candidate review <id> "operator" --approve --sha256 <artifactHash>
# 用户已授权的自动流程还需要 eligible=true：
node src/cli/dev.ts candidate review <id> "authorized automation" --approve --sha256 <artifactHash> --user-authorized
node src/cli/dev.ts candidate promote <id>
node src/cli/dev.ts candidate active sakura-learned-refresh
node src/cli/dev.ts candidate rollback <id> 1
```

使用外部自定义目录时，每条命令加同一个 `--control-dir`。真实对照入口：`node scripts/evaluate-candidate-pairs.ts --user-authorized`；已存在报告时拒绝覆盖，可用 `--output <new-directory>` 开始独立实验。排队参数为 `--after-report <matrix.json> --after-pid <known-live-pid>`；前序不完整停止或排队期间源码改变时停止，不并行推断或悄悄换版本。

## 验收

审查指定的七项安全回归已通过：名称冲突、旧版正文误匹配、审核后 description 篡改、两进程修订、发布中途故障、回滚一致性、项目审核状态伪造。额外覆盖验证脚本不能改审核数据/宿主代码、重复和样本不足的对照不能自动放行、正式技能的实际加载及篡改拒绝。测试采用真实 Pi Session 与脚本 provider，证明安全和数据合同；不作为真实模型进化收益。
