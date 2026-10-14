# Sakura Local-Only Mode

Sakura agents default to the local Ollama model `ollama/qwen3.5:4b`.

## Current behavior

- `createSakuraAgent()` uses Ollama when `model` is omitted.
- Cloud models are rejected by default, so learning and local tests do not accidentally use a paid API.
- Existing cloud provider implementations and credentials are untouched.

## Re-enable a cloud model later

Pass `localOnly: false` and provide the cloud model explicitly:

```ts
createSakuraAgent({
    ...configForRole("implementer", process.cwd()),
    localOnly: false,
    model: cloudModel,
});
```

Do not rely on the global default model when switching back. Explicitly pass the provider/model so the selected backend is visible in code and tests.