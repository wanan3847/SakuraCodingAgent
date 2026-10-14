---
name: example-skill
description: Explain how to add a second skill to this package. Use when the user is extending this plugin package itself.
---

# Example skill

SKILL.md 必须放在 `skills/<name>/SKILL.md`，且 frontmatter 里必须有 `name` 和 `description`。
`description` 决定它什么时候被加载，写具体一点——写 "Helps with X" 等于永远不被加载。

正文就是给模型看的操作说明。别写进 frontmatter，正文只在你被选中时才进上下文。
