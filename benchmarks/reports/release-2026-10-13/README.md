# 2026-10-13 个人版真实任务审计

模型：本地 Ollama `sakura-bench-qwen35-4b`，Pi 1.1.0，thinking off。原始试验在 2026-10-13 完成，本目录保留其 trial、answer、补丁和原始 manifest；`audit.json` 记录全新仓库中的重放检查。

| 任务 | 产物与判定 |
| --- | --- |
| auth-refresh | refresh 返回新 token；项目和冻结回归检查通过 |
| dependency-module | 新增 login-policy，并让消费者使用 loginLimit；两个文件集成后通过 |
| expiry-boundary | expires == now 判定过期；边界检查通过 |
| public-user | 输出不含 password 的新对象；检查通过 |
| read-only-review | 无改动；最终回答准确指出 auth-service.ts:2 返回旧 token |

四项编码任务和一次只读审查均通过。审计检查了全部实际 diff；依赖任务包含一个非必要的反向 import，当前没有顶层调用，ESM 和冻结检查均通过。这是保留的原始模型输出，不能将单次验收解释为整体质量或性能优势。

取消恢复另由真实 Pi Session + 脚本 provider 的 `control-recovery`、`pi-business-recovery` 和 `task-workspaces` 集成测试验证。它们证明控制与状态合同，不提供真实模型恢复质量结论。

可重复重放：在 `sakura/` 执行 `node benchmarks/runners/audit-release.ts`。安装、主题和原始检查报告在 `.sakura/release/`；本地安装包为 `.sakura/release/sakura-coding-agent-0.1.0.tgz`，校验值见 `installed-package.json`。三组重复基线、经验收益与消融仍需单独验收。
