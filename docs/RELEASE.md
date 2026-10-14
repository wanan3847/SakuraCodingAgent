# 本地个人版验收

2026-10-13 已完成四项真实模型编码与一次只读审查。全部补丁在全新固定仓库重放，项目类型/测试检查和仓库外冻结检查通过。新增文件由依赖任务覆盖，取消恢复由真实 Pi Session 的确定性集成检查覆盖。详见 [真实任务审计](../benchmarks/reports/release-2026-10-13/README.md)；完整实施记录位于源码仓库根目录的 `docs/实施记录.md`。

本轮交付是本地可安装产物；完整三组基线、消融与加固后候选的重复效果门槛仍在验收。用户已授权符合门槛后的自动批准，审批记录使用 user-authorized，不声称人工逐条审阅。

技能发布安全修复与平台边界见 [SKILL_SECURITY.md](SKILL_SECURITY.md)。七项指定安全回归通过；完整模型矩阵使用加固前快照，历史个人版任务报告也不作为加固后候选收益证据。最新安装检查报告及 tarball SHA256 以 `.sakura/release/installed-package.json` 为准。

在仓库根目录（就是包根目录）验证并生成包：

```bash
npm ci --ignore-scripts
npm run check
npm run check:plugin
node scripts/check-themes.mjs
node scripts/check-installed-package.mjs
```

最后一条命令在独立临时项目中安装打包产物，使用原生 `pi install -l` 登记并加载资源；通过后保留 `.sakura/release/sakura-coding-agent-0.1.0.tgz` 和包含 SHA256 的 `installed-package.json`。验证范围为 6 个扩展、2 个主题、5 个 Sakura 技能、2 个提示模板。

Pi 1.1.0 的干净宿主安装需要锁定 `@earendil-works/pi-codemode@1.1.0`，原因和安装步骤见 [README](../README.md)。模型与鉴权沿用 Pi 设置；缺少可用本地模型时先配置 models.json，local-only 不回退到云端。主题背景应与终端背景匹配。

在目标项目中按 [README 的干净宿主安装步骤](../README.md#从本地安装包创建干净宿主) 用 npm 安装 tarball，再用同一 Pi CLI 的 `install -l` 登记已安装的 Sakura 目录。Pi 的本地来源必须指向已解包的资源目录。

用原生 `/settings` 或启动参数 `--use-theme` 选择 `sakura-night` 或 `sakura-light`。任务流程、权限、产物应用和恢复命令见 README；改动需显式应用，不自动推送。卸载使用同一 CLI 的 `remove -l` 加安装时的已安装包目录路径。

## 发布到 GitHub Release

```bash
npm run release              # 生成 .sakura/release/{sakura.tgz,SHA256SUMS,install.sh,release-notes.md}
npm run release -- --publish # gh 创建 Release（需先 gh auth login；已存在的 tag 不会覆盖）
```

发布后的安装命令：

```sh
curl -fsSL https://github.com/wanan3847/SakuraCodingAgent/releases/latest/download/install.sh | sh
```

发布资产固定三个文件名（`sakura.tgz` / `SHA256SUMS` / `install.sh`），所以一行安装地址不随版本变化。包同时安装 `sakura` 与 `sakura-agent` 两个命令名。`scripts/install.sh` 会校验 `SHA256SUMS`，校验不通过即中止且不安装；`--version` / `--prefix` / `--dry-run` / `--tarball` 见脚本头部注释。发布前先跑 `npm run check`、`npm run check:plugin`、`npm run check:standalone`。
