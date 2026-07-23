# v0.4.8

NVIDIA NIM model support for GitHub Copilot Chat in VS Code.

## What's New in 0.4.8

- **Laguna XS 2.1.** Added `poolside/laguna-xs-2.1` with a 262,144-token context window and 16,384-token maximum output.
- **Reasoning controls.** Laguna now exposes `None` and `On` in the model picker. Inkling reasoning modes remain available from `None` through `Max`.
- **Reliable streaming.** Fixed Laguna responses being hidden as thinking when the API returned only normal content. Thinking blocks and orphaned `</think>` boundaries are still handled correctly.
- **Clearer API errors.** Model availability errors now include the NVIDIA model ID and explain that the issue is with the NIM endpoint or API key, not GitHub Copilot quota.

## Validation

- 258 Jest tests passing.
- TypeScript compilation passing.

## Install

Download the `.vsix` below -> Extensions view in VS Code -> Click the `...` menu -> Select **Install from VSIX...**

_Requires VS Code 1.125+, GitHub Copilot, and an API key from [build.nvidia.com/models](https://build.nvidia.com/models)._ 
