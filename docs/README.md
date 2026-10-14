# 🌸 Sakura 文档索引

更新：2026-10-13。所有文档集中在仓库根目录的 `docs/`；根目录 [README](../README.md) 是安装与使用说明。

Sakura Coding Agent 是基于 [Pi](https://github.com/earendil-works/pi) 官方包的工程 Agent：终端负责规划、编码、验证与交付，仓库理解、worktree 隔离、经验与技能演进由 Sakura 实现，模型/会话/工具/UI 全部复用 Pi。

## 从这里开始

| 目标 | 先读 |
| --- | --- |
| 装上并用起来 | [根 README](../README.md) |
| 现在到底做完了什么 | [完成度审计](完成度审计.md) |
| 接下来做什么 | [开发计划](开发计划.md) → [任务清单](任务清单.md) |
| 改 Pi 依赖版本 | [UPSTREAM](UPSTREAM.md) |
| 独立入口的安装与隔离细节 | [STANDALONE](STANDALONE.md) |
| 参与开发 | [DEVELOPMENT](DEVELOPMENT.md) |

## 全部文档

### 计划与状态

| 文档 | 用途 |
| --- | --- |
| [开发计划](开发计划.md) | 产品目标、代码现状、技术边界、里程碑与发布标准 |
| [任务清单](任务清单.md) | 按依赖排序的任务、实现位置、完成条件与证据 |
| [完成度审计](完成度审计.md) | 各模块实际完成度、证据边界、已知缺口与插件评估 |
| [实施记录](实施记录.md) | 逐轮实际修改、检查证据与当时状态（历史条目里的 `sakura/…` 路径是拆分前的布局） |

### 设计依据（历史文档）

| 文档 | 用途 |
| --- | --- |
| [架构与开发路线](架构与开发路线.md) | 模块边界、数据结构、运行流程、开发顺序与评测设计；§ 编号被源码注释引用 |
| [Pi 复用指南](Pi复用指南.md) | Pi 复用什么、怎么接入、边界与防重复造轮子检查表 |
| [reuse-decisions](reuse-decisions.md) | ADR：源码副本 → 官方包/原样检出的取舍记录 |

### 使用与运维

| 文档 | 用途 |
| --- | --- |
| [STANDALONE](STANDALONE.md) | 独立入口：安装、启动、独立配置、终端与网站 |
| [RELEASE](RELEASE.md) | 本地个人版验收、打包产物与 SHA-256 回执 |
| [UPSTREAM](UPSTREAM.md) | Pi 基线、依赖解析、升级 runbook、合同覆盖与不验证范围 |
| [DEVELOPMENT](DEVELOPMENT.md) | 开发环境、目录边界、能改什么/不能改什么 |
| [ollama-local-only](ollama-local-only.md) | 本地 Ollama 与 local-only 策略 |
| [FEATURE_GAPS](FEATURE_GAPS.md) | 本轮已补齐能力与剩余差距 |
| [CODING_CAPABILITIES](CODING_CAPABILITIES.md) | 本轮能力的实现位置、验收命令与证据 |
| [SKILL_SECURITY](SKILL_SECURITY.md) | 技能发布安全合同：权威存储、事务恢复、效果门槛、自动批准 |

### 界面与扩展

| 文档 | 用途 |
| --- | --- |
| [樱花风格规范](樱花风格规范.md) | 配色、终端布局、交互与文案规范 |
| [FRONTEND_DESIGN](FRONTEND_DESIGN.md) | 网站与工作台的设计约定 |
| [PLUGIN-GUIDE](PLUGIN-GUIDE.md) | 写自己的 Pi 插件/包（含 `templates/pi-plugin` 骨架） |
| [CODEX_PI_REUSE_RESEARCH](CODEX_PI_REUSE_RESEARCH.md) | Codex / Pi 官方能力的复用调研 |

### 兼容记录

| 文件 | 用途 |
| --- | --- |
| [pi-compatibility.json](pi-compatibility.json) | 已验收的 Pi 版本、来源 commit、通过的检查与合同 |

## 文档关系

- 开发计划 §0 和 §4 说明采用规则与阶段对照；技术边界差异以 [Pi 复用指南](Pi复用指南.md) 的口径为准。
- 接入方式已由 [ADR-003](reuse-decisions.md) 收敛为「官方 Pi 包 + 公开类型」；ADR-001/002 只解释历史背景。
- 新增产品需求涉及已有技术决策变更时，先补 ADR，再改实现。
- 任务完成时更新[任务清单](任务清单.md)并记录实际验收证据；完成度与结论以[完成度审计](完成度审计.md)为准。
- 实际可用入口以仓库根目录 `package.json` 与 CLI 源码为准。
