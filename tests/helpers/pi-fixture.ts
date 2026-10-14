import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import type { SakuraAgentConfig } from "../../src/runtime/agent-config.ts";

export const usage = { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export type Reply = (context: TranscriptContext, options: SimpleStreamOptions | undefined, call: number) => Promise<Partial<AssistantMessage>> | Partial<AssistantMessage>;
/** Mock only the provider boundary; the Pi session, tools, events and persistence are real. */
export async function piFixture(reply: Reply) {
  const directory = await mkdtemp(join(tmpdir(), "sakura-pi-contract-"));
  const requests: TranscriptContext[] = [];
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(directory, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.registerProvider("contract", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "contract",
    models: [{ id: "scripted", name: "Scripted contract", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      requests.push(context);
      const call = requests.length;
      queueMicrotask(async () => {
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage, stopReason: "stop", timestamp: Date.now() };
        try {
          stream.push({ type: "start", partial: message });
          Object.assign(message, await reply(context, options, call));
          if (options?.signal?.aborted) { message.stopReason = "aborted"; message.errorMessage = "contract aborted"; }
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            stream.push({ type: "error", reason: message.stopReason, error: message });
          } else {
            for (const [index, content] of message.content.entries()) {
              if (content.type === "text") stream.push({ type: "text_delta", contentIndex: index, delta: content.text, partial: message });
            }
            stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
          }
        } catch (error) {
          message.stopReason = "error"; message.errorMessage = String(error);
          stream.push({ type: "error", reason: "error", error: message });
        }
      });
      return stream;
    },
  });
  await modelRuntime.refresh({ allowNetwork: false });
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "contract", defaultModel: "scripted", retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 512 } });
  const config: Partial<SakuraAgentConfig> = { agentDir: directory, modelRuntime, settingsManager, sessionMode: "memory" };
  return { directory, requests, config, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
