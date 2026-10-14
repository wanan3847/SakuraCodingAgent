# my-pi-agent（插件包模板）

复制这个目录，改 `package.json` 的 name，然后：

```bash
npm install                     # 装 pi 的类型定义（extensions/*.ts 里 import type 用）

# 开发循环：改完直接 --reload 或重跑
pi -e ./extensions/example.ts --no-session -p "call example_greet with name=world and print the raw result"

# 整包加载（走 package.json 的 pi manifest：extensions + skills + prompts 一起）
pi -e "$PWD" --no-session -p "list your available tools, comma separated"

# 装成常驻 agent
pi install "$PWD"      # 写 ~/.pi/agent/settings.json
pi list
pi install -l "$PWD"   # 写 .pi/settings.json（跟项目走，可提交给团队）
```

`pi -e` 只对本次运行生效，不写 settings——调试用这个，别拿 `install` 试。
