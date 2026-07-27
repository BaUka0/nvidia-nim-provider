# v0.4.10

## Long chats no longer break

Previously, a long Copilot Chat session could fail with a cryptic "maximum context length" error and stay broken until you started a new chat. Now the extension handles this automatically:

- When the server says your conversation is too long, the extension reads the exact token limit, shortens the history by summarizing older turns, and retries — all without any action from you.
- The discovered limit is remembered for the rest of the session, so the same model won't hit the same wall again.
- If the retry still doesn't fit, you get a clear message with the model name, the limit, and how many tokens your conversation used — so you know exactly what happened.

## More accurate model settings

Output token limits now match what each model actually supports, so you get the full response length the model can produce:

| Model | Max output |
|-------|----------:|
| DeepSeek V4 Flash / Pro | 131,072 |
| GLM 5.2 | 131,072 |
| Step 3.7 Flash | 262,144 |
| Laguna XS 2.1 | 65,536 |

Context window sizes were also corrected for GLM 5.2 (1M), MiniMax M3 (1M), and Nemotron 3 Ultra (1M) based on live endpoint measurements.

## Smoother streaming and tool calls

- Tool calls that arrive in fragmented or malformed chunks are now repaired automatically instead of being silently dropped.
- Duplicate tool calls are suppressed, and tool results are converted more reliably.
- Cancelling a request mid-stream is now clean — no hanging connections or stale state.

## Better reliability under the hood

- Your API key is handled more securely: it's no longer stored in model metadata or printed in logs, and switching keys correctly invalidates all cached data.
- The image analysis tool (`nvidia_nim_analyze_image`) now registers properly on startup, so it's always available when you need it.
- Switching models or refreshing the model list can no longer leave image requests pointed at the wrong model.
- The status bar token counter now shows accurate numbers, including images and tool results.

## Install

Download the `nvidia-nim-agent-0.4.10.vsix` file and install it from the VS Code Extensions view using **Install from VSIX...**
