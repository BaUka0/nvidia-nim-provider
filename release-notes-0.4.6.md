# v0.4.6

VS Code extension that integrates the best models from NVIDIA NIM into GitHub Copilot Chat. Get access to powerful models like DeepSeek, Kimi, GLM, Nemotron, MiniMax, and Stepfun right in your editor.

## What's New in 0.4.6

- **Fix Reasoning Toggle for GLM-5.2.** Fixed a bug where enabling the reasoning switch on `z-ai/glm-5.2` caused the NVIDIA NIM API to fail with an empty response/error. Included `"clear_thinking": false` in the request's `chat_template_kwargs` to align with the official NVIDIA NIM API parameters.
- **Under-the-Hood Chat Provider Refactoring (v0.4.5).** Significantly improved the internal codebase structure, testability, and separation of concerns by extracting modular logic from the main provider class:
  - Extracted request options construction, token limit handling, and parameter profiling to a new `NimRequestBuilder` class.
  - Extracted streaming tool call schema matching, chunk buffering, and repair/aggregation logic to a new `ToolCallStreamAggregator` class with lazy initialization (matching test mock expectations).
  - Delegated model picker information mapping logic entirely to the `NvidiaModelDiscoveryService` in `discovery.ts`.
  - Cleaned up duplicate state variables and unused imports inside `chat-provider.ts`.
- **Improved Stream Routing for GLM/DeepSeek/Stepfun (v0.4.4).** Features a `contentStartedBeforeReasoning` tracking mechanism and a **150-character buffer** to accurately separate thinking/reasoning from the actual response text.

## Install

Download the `.vsix` below -> Extensions view in VS Code -> Click the `...` menu -> Select **Install from VSIX...**

*Requires VS Code 1.125+, GitHub Copilot, and an API key from [build.nvidia.com/models](https://build.nvidia.com/models).*
