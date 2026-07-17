# v0.4.7

VS Code extension that integrates the best models from NVIDIA NIM into GitHub Copilot Chat. Get access to powerful models like DeepSeek, Kimi, GLM, Nemotron, MiniMax, Stepfun, and Inkling right in your editor.

## What's New in 0.4.7

- **Inkling support.** Added `thinkingmachines/inkling` to the curated model catalog with a **1,000,000-token context window** and a configured **65,536-token maximum output**.
- **Vision and tool calling.** Inkling is available for multimodal prompts and agent workflows that use tools.
- **Automatic catalog refresh.** Updated the model cache version so existing installations discover Inkling after upgrading, without requiring a manual cache reset.

## Install

Download the `.vsix` below -> Extensions view in VS Code -> Click the `...` menu -> Select **Install from VSIX...**

_Requires VS Code 1.125+, GitHub Copilot, and an API key from [build.nvidia.com/models](https://build.nvidia.com/models)._
