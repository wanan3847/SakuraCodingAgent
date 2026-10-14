# 经验检索重复对照

2026-10-13，固定 `repeated-refresh` commit、Ollama `sakura-bench-qwen35-4b`、thinking off、工具集合和 600 秒超时，各组重复三次。三次有经验组的 Context Pack 均包含真实来源 run 与成功动作；无经验组均没有该条目。来源来自此前独立完成的 auth-refresh，未使用本次任务答案生成种子。

| 指标（包含未通过尝试） | 无经验 | 有经验 |
| --- | ---: | ---: |
| 通过 | 2/3 | 3/3 |
| 平均耗时 / 秒 | 293.5 | 167.6 |
| 平均输入 token | 108,611 | 60,295 |
| 平均输出 token | 3,565 | 1,629 |
| 平均工具调用 | 24.7 | 15.0 |

这是一个任务的三个重复样本；无经验第三次仅 34.5 秒，快于全部有经验尝试。结果显示本样本的平均值改善，但没有证实通用收益。无经验第二次超时 601.9 秒，旧执行器将其标为 `cancelled`，统计始终纳入未通过尝试。新执行器已单独将超时标为失败。

此历史执行器尚未计入索引读取，且重规划可能覆盖旧 retry 计数，因此不使用 `filesRead`/`retries` 推断收益。原始源码指纹保留，但本轮启动时没有源码归档；完整三组矩阵使用修正后的口径及源码快照。

[审计](audit.json) 核对全部 Context Pack 与结果，[原始报告](original-report.json) 保留六次数据。各子目录含原始 Trace、补丁及判定器；[种子](seed/experiences.json) 和 `seed-source-run/` 保存来源。可重新核对：`node benchmarks/runners/audit-experience.ts`（需原始本地报告）。
