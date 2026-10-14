# extensions/

**一个模块一个文件，六个文件。**

```
src/<模块>/                  这个模块的**逻辑**。纯 TypeScript，能单测，不知道 Pi 存在
src/index.ts                 库的公开 API（显式列名，不用 export *）
extensions/sakura-<模块>.ts  该模块的**插件**：注册工具/命令/钩子，逻辑全部调 src/
```

不用中间层：插件文件本身就是"对外长什么样"那一层。三层减成两层。

| 文件 | 工具 | 命令 | 注册的其他东西 |
|---|---|---|---|
| `sakura-planning.ts` | `sakura_plan` | `/sakura-plan` | |
| `sakura-orchestrator.ts` | `sakura_run` | `/sakura-run` `/sakura-status` | |
| `sakura-repo.ts` | `sakura_repo` | `/sakura-repo` | |
| `sakura-workspace.ts` | `sakura_workspace` | `/sakura-workspace` | **`tool_call` 权限钩子**（唯一一处） |
| `sakura-experience.ts` | `sakura_experience` | `/sakura-experience` | |
| `sakura-subagent.ts` | `sakura_delegate` | `/sakura-delegate` | |

`package.json` 的 `pi.extensions` **逐个列出这六个**——不用 `./extensions` 全局匹配，
这样以后放辅助文件或实验代码不会意外被加载。

## 六个文件的成本，和对应的保护

| 成本 | 保护 |
|---|---|
| 每个文件都要 `export default function`，漏一个 pi 起不来 | `npm run check:plugin` 静态扫 |
| 工具名/flag 名**全局唯一**，撞名 pi 起不来 | `npm run check:plugin` 跨文件扫重名 |
| manifest 漏列一个 = 它静默不加载 | `npm run check:plugin` 校验路径存在 |
| 只在启动时报错，那时候已经晚了 | 上面的检查都在本地、启动前 |

```bash
npm run check:plugin          # = node scripts/check-plugin.mjs .
```

这条命令现在是**必需的**，不是可选的：六个文件意味着六倍的手工一致性要求，
而 Pi 只在启动时告诉你哪里不对（`Failed to load extension ... ` 然后 exit 1）。

## 权限钩子只能有一处

`tool_call` 钩子在 `sakura-workspace.ts` 里，它是唯一安装 sandbox 策略的地方。

多个插件同时订阅 `tool_call` 是允许的（handler 会串联），但**策略只该有一份**——
两份策略会让同一个动作被两个规则判定，出问题时你分不清是谁拦的。
要加规则改 `src/workspace/sandbox-policy.ts`，不要在别的插件里再挂一个钩子。

## 加第 7 个插件

1. 新建 `extensions/sakura-xxx.ts`，**必须** `export default function (pi) {}`
2. 写进 `package.json` 的 `pi.extensions`
3. 工具名别和上面六个撞（`npm run check:plugin` 会告诉你）
4. `pi -e ./extensions/sakura-xxx.ts -t <工具名> --no-session -p "调用它并原样打印结果"`
