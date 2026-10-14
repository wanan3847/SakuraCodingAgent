# 本地模型端到端验收

十项固定任务、Git bundle 与不可篡改检查位于 `benchmarks/`。每次试验复制固定 commit，在独立仓库执行，并保存任务 diff、Pi/Sakura Trace、模型回答、检查输出和统计原始数据。已运行的离线测试只证明任务和判定器可复现，不代表本地模型已经完成编码任务。

本地 Ollama 模型启动后，在仓库根目录运行：

```bash
PI_CODING_AGENT_DIR="$PWD/.sakura/benchmark-agent" node benchmarks/runners/run.ts --model ollama/sakura-bench-qwen35-4b --variants sakura --task auth-refresh,new-cache,read-only-review --repeats 1
```

完整矩阵先用 `--dry-run` 查看。B 组需先按 `docs/UPSTREAM.md` 锁定社区 npm 产物与工具上限；报告的 `metricsScope` 也须保留，根会话统计不可当作嵌套调用总量。最终通过须有真实代码改动、冻结的外部检查和只读审查定位；失败与取消都进入原始报告。
