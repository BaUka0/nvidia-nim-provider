# v0.4.3

VS Code extension that integrates the best models from NVIDIA NIM into GitHub Copilot Chat. Get access to powerful models like DeepSeek, Kimi, GLM, Nemotron, MiniMax, and Stepfun right in your editor.

## What's New in 0.4.3

- **Reasoning no longer leaks into chat mid-stream.** On models with `reasoning_content` (DeepSeek, GLM, MiniMax, Nemotron), long reasoning sessions — especially during code analysis — could break out of the thinking block and appear as plain English text in the chat. The model would finish thinking in chat, then give the final answer in the user's language. Three fixes now keep the chain-of-thought inside the collapsible thinking block:
  - **Orphaned close-tag split.** When the NIM template parser breaks on code fences, it can leave a bare `</think>` or `</mm:think>` in `content` without the opening tag. This is now detected and used as a boundary: text before it goes to the thinking block, text after it is the answer.
  - **Pre-reasoning content buffering.** When reasoning is enabled but the model hasn't started sending `reasoning_content` yet, any untagged `content` is treated as reasoning and shown in the thinking block — not dumped into chat.
  - **Code-fence balancing.** If a reasoning chunk ends on an unclosed ` ``` ` fence, the thinking block's markdown would break and visually "escape." The fence is now tracked and balanced so the thinking block stays intact.

- **Status bar tooltip now marks actual token counts.** The "Input Total" row shows `*(actual)*` when real `prompt_tokens` are available from the API, matching the existing test expectation.

- **New debug logging for stream chunks.** Enable `NVIDIA NIM: Toggle Debug Logging` and each SSE chunk is logged to the Output channel with `reasoning_content` / `content` flags and head/tail previews — so template-break leaks can be diagnosed without guessing.

## Install

Download the `.vsix` below -> Extensions view -> **Install from VSIX...**

Requires VS Code 1.125+, GitHub Copilot, and an API key from [build.nvidia.com/models](https://build.nvidia.com/models).
