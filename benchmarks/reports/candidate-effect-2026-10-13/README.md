# 真实候选效果对照（macOS）

三任务（auth-refresh、repeated-refresh、expiry-boundary）各三对，共 18 次已完成。冻结源码 d300719aa848fbf505d0a2688f964f92a150416412180761d013172dc1b0600b，在前端改版合入之前完成，模型为本地 Ollama sakura-bench-qwen35-4b。当前 Web 读取的是实际落盘的运行记录。

基线通过 9/9，候选通过 8/9；工具调用 158 → 125，总 token 597642 → 594024。由于候选存在失败，效果门槛不通过，保持 assessed/evaluated，未自动批准或发布。节省调用量不能抵消回归失败，也不能证明一般任务收益。

原始进度、每次 state/events/diff/冻结检查和来源归档在源码目录 `.sakura/release/candidate-effect-macos-v3`。此目录中的 result.json 是可审阅摘要，不代替权威运行回执。服务器 240 次矩阵是独立实验，不混入本次样本。
