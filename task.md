- `[x]` Delete unsupported adapters (Llama, Claude, GPT, Mistral, Qwen, Phi, Yi, Gemma)
- `[x]` Update `src/models/adapters/index.ts`
- `[x]` Update `src/models/adapters/glm.ts`
- `[x]` Update `src/models/adapters/deepseek.ts`
- `[x]` Update `src/models/adapters/nemotron.ts`
- `[x]` Update `src/models/adapters/kimi.ts`, `minimax.ts`, `stepfun.ts`
- `[x]` Update `src/provider/chat-provider.ts`
- `[x]` Clean up `package.json`
- `[x]` Run tests and fix any issues

## Future Enhancements
- `[x]` Implement state machine / stream buffer in `chat-provider.ts` to intercept Kimi's `<think>` tags and natively emit them as `LanguageModelThinkingPart` instead of raw text.
