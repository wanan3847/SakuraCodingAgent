---
name: sakura-learned-refresh
description: "refresh stale token regression 刷新 token 回归检查"
---

# Refresh token regression

证据来源：固定 auth-refresh 任务的已验证补丁，修改 src/auth/auth-service.ts，使 refresh(current, next) 返回 next。

1. 读取当前 refresh 的实现及调用方，确认返回旧 token 的问题仍然存在；历史补丁只作为线索。
2. 保持公开函数签名，返回已轮换的新 token，避免修改无关文件或测试判定器。
3. 运行项目类型检查与回归测试；没有 shell 工具时说明由 Sakura 外层执行检查，不声称自己已执行。
4. 记录实际 diff、检查命令、退出码和剩余问题。单次成功不代表适用于所有 token 系统。
