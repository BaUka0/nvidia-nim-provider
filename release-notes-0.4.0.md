# v0.4.0

VS Code extension that integrates the best models from NVIDIA NIM into GitHub Copilot Chat. Get access to powerful models like DeepSeek, Kimi, GLM, Nemotron, MiniMax, and Stepfun right in your editor.

## What's New in 0.4.0

- **Token Breakdown UI**: Added a detailed tooltip to the status bar (`$(zap)`) showing token usage by category (System Prompt, User/Assistant Messages, Tool Calls, etc.).
- **Accurate Token Reporting**: The extension now properly requests streaming usage from the NVIDIA API (`stream_options: { include_usage: true }`), ensuring correct input/output token metrics.
- **Fixed Token Undercounting**: Resolved an issue where tool calls and images were undercounted in the context window estimation.
- **System Message Fix**: Correctly classifies system messages so Copilot Chat's system prompt is accurately tracked in the token breakdown.

## Install

Download the `.vsix` below → Extensions view → **Install from VSIX...**

Requires VS Code 1.125+, GitHub Copilot, and an API key from [build.nvidia.com/models](https://build.nvidia.com/models).
