# Change Log

## [0.4.6] - 2026-07-03

### Fixed

- **Reasoning Toggle for GLM-5.2.** Fixed a bug where enabling the reasoning switch on `z-ai/glm-5.2` caused the NVIDIA NIM API to fail with an empty response/error. Included `"clear_thinking": false` in the request's `chat_template_kwargs` to align with the official NVIDIA NIM API parameters.

## [0.4.5] - 2026-07-03

### Changed

- **Refactored `chat-provider.ts` code structure.** Extracted modular logic from the main provider file into dedicated classes to improve maintainability and testability:
  - Extracted request options construction, token limit handling, and parameter profiling to `NimRequestBuilder`.
  - Extracted streaming tool call schema matching, chunk buffering, and repair/aggregation logic to `ToolCallStreamAggregator` with lazy initialization.
  - Delegated picker information mapping logic entirely to `NvidiaModelDiscoveryService` in `discovery.ts`.
  - Cleaned up duplicate functions and unused imports inside `chat-provider.ts`.

## [0.4.4] - 2026-07-03

### Added

- **Integration for `z-ai/glm-5.2`.** Added full support for the new elite reasoning/agentic model `z-ai/glm-5.2`, featuring a 1,000,000 token context window and 128,000 token output capability.
- **Improved Stream Routing for GLM/DeepSeek.** Added a `contentStartedBeforeReasoning` tracking mechanism and a 150-character buffer to cleanly separate models that stream reasoning in `content` from those using a distinct `reasoning_content` delta field. This fixes a critical bug where GLM 5.2's initial response text was incorrectly routed to and trapped in the collapsible thinking block.

### Removed

- **GLM 5.1 Model.** Removed the obsolete `z-ai/glm-5.1` model from the whitelist and all tests.

## [0.4.3] - 2026-06-27

### Fixed

- **Reasoning leaked into chat mid-stream (DeepSeek, GLM, MiniMax, Nemotron).** When the NIM chat-template parser broke on code fences inside reasoning (common during long code-analysis tasks), the model's chain-of-thought would exit the thinking block and appear as plain English text in the chat — while the final answer still came in the user's language. Three independent fixes now keep reasoning inside the collapsible thinking block:
  - **Orphaned close-tag detection.** When the template breaks, it can leave a bare `</think>` or `</mm:think>` in `content` without the opening tag. This is now detected and used as a split point: everything before it is routed to `LanguageModelThinkingPart`, everything after is the answer.
  - **Pre-reasoning content routing.** When reasoning is enabled but `reasoning_content` has not yet appeared, untagged `content` is buffered as reasoning instead of being shown in chat. Once `reasoning_content` arrives (or an orphaned close tag is found), the buffer is flushed as a thinking part and subsequent content is treated as the answer.
  - **Code-fence balancing for thinking parts.** If a reasoning chunk ends on an unclosed ` ``` ` fence, the `LanguageModelThinkingPart` markdown would break and visually "escape" the thinking block. The fence parity is now tracked; the buffer is held until the fence closes (or force-closed with a synthetic ` ``` ` when the answer begins).
- **Status bar tooltip did not mark actual token counts.** The `*(actual)*` annotation was missing from the "Input Total" row when real `prompt_tokens` were available from the API.

### Added

- **Diagnostic stream chunk logging.** Under `NVIDIA_NIM_DEBUG=1`, each SSE chunk is logged with `reasoning_content` / `content` presence flags, head/tail previews, and `finish_reason` — making it possible to diagnose template-break leaks from the Output channel without guessing.

## [0.4.2] - 2026-06-27

### Fixed

- **MiniMax M3 and Kimi K2.6 were not streaming responses.** The entire response was buffered and only shown at the end of generation, leaving the user staring at an empty chat. Text now streams token-by-token in real time for all models.
- **Reasoning tokens were splitting the answer in half.** When the NIM API sends reasoning and content tokens in the same SSE chunk (common with MiniMax M3), reasoning could end up in the middle of the response. Reasoning is now always processed before content.
- **MiniMax M3 ignored the reasoning mode selection.** The reasoning parameter was sent in the wrong format, so the model could not see it and always fell back to adaptive mode. None, On, and Adaptive now work correctly.
- **Kimi K2.6 ignored the reasoning toggle.** The parameter was placed at the wrong level of the request, so the model never received it and always thought (or never thought) regardless of the user choice.
- **Response text was corrupted when the model mentioned think-tags in code.** If a model with `reasoning_content` (DeepSeek, MiniMax, GLM, Nemotron) quoted literal `<think>` or `<mm:think>` strings in its answer — for example when analyzing source code — the tag filter mistook them for real reasoning tags and tore the response apart. The tag filter is now disabled entirely for models that use `reasoning_content`; content passes through untouched. Models without `reasoning_content` (Kimi, StepFun) still get tag filtering as before.
- **MiniMax M3 reasoning was not displayed.** The model uses its own `<mm:think>`/`</mm:think>` tags, which were not recognized. They are now handled alongside `<think>`/`</think>`.

### Added

- **Adaptive reasoning mode for MiniMax M3.** A third option — **Adaptive** — is now available in the model dropdown alongside None and On. In adaptive mode, the model decides on its own whether to reason step-by-step based on query complexity.

## [0.4.0] - 2026-06-26

### Added
- **Token Breakdown in Status Bar**: After each response, the status bar now displays full context window utilization in `X/Y` format (e.g. `$(zap) Kimi K2.6: 25.5k/262.1k`). Hovering over the status bar item reveals a detailed Markdown tooltip with a per-category token breakdown table:
  - System Prompt, Tools (definitions), User Messages, Assistant Messages, Tool Calls, Tool Results, Images/Media, Input Total, Output (completion), and Total Used.
  - When actual `prompt_tokens` are available from the NVIDIA API, category estimates are proportionally scaled to match the real total (marked `*(actual)*`).
  - Context usage color indicators: warning background at >80%, error background at >95% of the context window.
- **Categorized Token Estimation**: New `estimateMessagesTokensByCategory` and `estimateToolsTokens` functions classify message content parts by role and type (text, tool calls, tool results, images, tool definitions), providing granular token attribution for the breakdown.
- **New Status Bar Icon**: Replaced the `$(copilot)` icon with `$(zap)` (lightning bolt) across all status bar states to avoid visual duplication with the Copilot icon.

### Fixed
- **`provideTokenCount` Token Undercounting**: The provider's `provideTokenCount` method previously only extracted text from `LanguageModelTextPart` and string `.value` fields; all other part types (`LanguageModelToolResultPart`, `LanguageModelToolCallPart`, text-mime `LanguageModelDataPart`, image parts) were counted as a flat 2 tokens regardless of size. This caused VS Code's context-window token breakdown to disappear for tool-heavy agent conversations. The method now reuses the converter's part-extraction helpers (`getTextPartValue`, `getDataPartTextValue`, `getToolResultTexts`, `getToolCallInfo`) to accurately estimate tokens across all content-array part types. A `try/catch` guard resolves to `0` on any error to prevent hanging VS Code's breakdown UI.
- **System Message Role Classification**: `estimateMessagesTokensByCategory` used a hardcoded `role === 0` check for system messages, but VS Code's internal `LanguageModelChatMessageRole.System` is `3` (from the proposed `languageModelSystem` API), not `0`. Fixed with a fallback logic matching `convertMessages`: any role that is not `User` (1) or `Assistant` (2) is classified as system, ensuring Copilot Chat's system prompt is correctly attributed in the breakdown.

### Changed
- **Status Bar Click Behavior**: Clicking the status bar item after a chat response no longer triggers model refresh (the `command` is set to `undefined`). Model refresh is still available via the Command Palette and the refresh lifecycle states (`showOk`, `showRefreshing`, `showError`).
- **`estimateMessagesTokens` Refactor**: Now delegates to `estimateMessageTokens` / `estimatePartTokens`, improving input token estimation accuracy for tool-heavy conversations in the context compression logic.

## [0.3.0] - 2026-06-25

### Added
- **Token Usage Status Bar**: After each response, the status bar shows real-time token usage (`$(copilot) Model: 1.2k→850`) with compact k/M formatting. The status bar is now also wired to model refresh (shows model count, refreshing spinner, and errors).
- **Auto-Fallback on Rate Limit**: When a model returns HTTP 429 (rate limited), the extension automatically retries with DeepSeek V4 Flash (the lightest model in the whitelist) and shows a notification. Prevents dead-end errors during heavy usage.
- **Streaming Retry on Network Error**: If a streaming connection drops mid-response (network error, ECONNRESET, socket failure) and no content was emitted yet, the extension retries up to 2 times with a system message asking the model to start over.
- **Context Compression via API Summarization**: Long conversations that exceed the model's context window are now automatically compressed instead of throwing a hard error. Old messages are summarized via a lightweight DeepSeek Flash API call, preserving key context (decisions, file paths, code references). Falls back to simple truncation if the summarization API call fails.

## [0.2.8] - 2026-06-25

### Added
- **Think-Tag Reasoning Capture**: Reasoning emitted inline within ` think... /think` tags (used by Kimi models) is now intercepted and natively rendered as `LanguageModelThinkingPart` collapsible thinking blocks, instead of being stripped and discarded. A shared `emitReasoning` helper now unifies handling of both `reasoning_content` deltas and ` think`-tag content.

## [0.2.7] - 2026-06-25

### Added
- **Dynamic Reasoning Effort Picker**: Added full support for configuring the reasoning effort directly via the VS Code Copilot Chat dropdown menu (`LanguageModelChatInformation.configurationSchema`). The dropdown intelligently updates its options based on the selected model:
  - **DeepSeek**: `None`, `High`, `Max`
  - **Nemotron**: `None`, `Medium`, `High`
  - **Kimi**, **MiniMax**, **GLM-5.1**: `None`, `On`
  - **Stepfun-3.7-flash**: Unconditionally reasons by default (no manual toggle required).
- **Native VS Code Reasoning UI**: Integrated the proposed `LanguageModelThinkingPart` API. When running in VS Code Insiders, the reasoning tokens (`reasoning_content`) emitted by the models will be captured and beautifully rendered as collapsible thinking blocks within the chat interface, instead of being dumped as raw text!
- **Advanced Payload Configuration**: Implemented `chat_template_kwargs` to seamlessly inject advanced reasoning parameters into the NVIDIA NIM REST payload. This properly supports complex models like DeepSeek, GLM, and MiniMax that require nested arguments.

### Changed
- Refined the default label for reasoning toggles: renamed "Default (Off)" to "None" across the entire codebase to reduce ambiguity and align with standard terminology.
- Simplified `Stepfun-3.7-flash` adapter by entirely removing the manual reasoning mode selectors to mirror upstream changes (the model automatically thinks without needing an explicit toggle).
- Streamlined `nvidia-nim.reasoningMode` workspace setting defaults to dynamically map to the appropriate first valid state (`none`) instead of hardcoding `default`.
- Bumped internal Node APIs and updated types to handle the experimental `languageModelThinkingPart` API proposals in `package.json`.

### Fixed
- **GLM-5.1 & MiniMax-M3 Crashes**: Fixed a critical `400 Bad Request` validation error (`Unsupported parameter(s): enable_thinking`) by correctly routing their reasoning config options through `chat_template_kwargs` rather than injecting it at the root of the API payload.
- **DeepSeek Argument Compatibility**: Corrected DeepSeek's `thinking` and `reasoning_effort` API mapping. Now properly nests these parameters inside `chat_template_kwargs` so the NIM backend successfully activates DeepSeek-V4's advanced reasoning capabilities without throwing validation errors.

## [0.2.6] - 2026-06-25

### Added
- Enabled experimental `LanguageModelThinkingPart` in `package.json`'s `enabledApiProposals` to prepare for native reasoning token rendering in VS Code Insiders.

### Changed
- Forced a version bump to bypass aggressive VS Code local VSIX caching. This ensures users installing the latest build actually receive the updated streaming code.

## [0.2.5] - 2026-06-25

### Added
- Introduced explicit reasoning capabilities for **GLM-5.1**.

### Removed
- **Massive Codebase Refactoring**: Completely purged all non-core, outdated, or experimental model adapters to heavily streamline the provider. We have officially dropped support for:
  - Mistral / Mixtral (all variants)
  - Qwen (all variants)
  - Phi (all variants)
  - Yi (all variants)
  - Gemma
  - Llama-4 Scout
  - Older Nemotron iterations (Nemotron 4, Nemotron Ultra)
- The extension now strictly focuses on maintaining high-quality integrations for exactly 6 core reasoning models: **DeepSeek**, **Nemotron**, **Kimi**, **MiniMax**, **Stepfun**, and **GLM**.

## [0.2.4] - 2026-06-25

### Added
- Implemented the foundational infrastructure to support the new `configurationSchema` property within the VS Code API. This allows model providers to inject custom dropdown selectors into the VS Code Copilot Chat UI.
- Dynamically mapped adapter configurations (`supportedReasoningModes`) to the VS Code UI schema properties.

## [0.2.3] - 2026-06-25

### Fixed
- Fixed internal test suite failures and updated `BaseModelAdapter` mocks to verify `applyReasoningMode` integration.
- Corrected payload merging logic to ensure temperature and reasoning options don't conflict.

## [0.2.2] - 2026-06-25

### Added
- Created the `applyReasoningMode` abstract method in the base adapter interface to enforce unified reasoning configurations.
- Hooked up `DeepSeek`, `Kimi`, `MiniMax`, and `Nemotron` to correctly respond to the newly injected reasoning modes (`default`, `on`, `low`, `medium`, `high`, `max`).

## [0.2.1] - 2026-06-25

### Added
- Added a fallback workspace configuration property: `nvidia-nim.reasoningMode`. If a model doesn't explicitly pass a UI configuration via the dropdown, it will gracefully fallback to the workspace default setting.

## [0.2.0] - 2026-06-25

### Added
- **Major Feature Initialization**: Began implementing robust support for Model Reasoning (Thinking) configurations.
- Added the `nvidia-nim.showReasoning` workspace setting to allow users to expose hidden `<think>`/`reasoning_content` tokens directly into the chat stream for debugging or deeper analysis.

## [0.1.23] - 2026-04-29

### Changed

- Reduced chat hot-path overhead by collapsing message conversion into a single content pass and by avoiding no-op copies in the Kimi reasoning-content workaround.
- Deferred tool parsing state construction until a response actually needs tool handling, reducing unnecessary per-request work on plain text chats.
- Expanded debug stream timing logs with request-preparation and lazy tool-parsing initialization durations so latency tuning can distinguish setup cost from first-token delay.

## [0.1.22] - 2026-04-26

### Added

- Model profiles for Mistral/Mixtral, Qwen, Phi, Yi, and Gemma model families with per-family temperature defaults and tool-use system messages.
- Known model display-name overrides for Llama-4 Scout, Nemotron 4, Nemotron Ultra, Mistral Large, Mixtral 8x22B, Qwen 2.5 (72B/Coder 32B), Phi 3.5 Mini, Yi Large, and Gemma 2.
- Expanded VS Code mock for better test coverage (EventEmitter, CancellationError, Disposable, etc.).

### Changed

- Model-profile matching uses word-boundary regex instead of naive `includes()` to avoid false matches.
- Image analysis requests now use `fetchWithRetry` and include a User-Agent header.
- Token estimation is now character-type-aware (CJK vs. Latin) for better accuracy while retaining a safety margin.
- Unrecognized message parts log via the debug channel instead of `console.warn`.

## [0.1.21] - 2026-04-26

### Fixed

- Stop leaking split or truncated DSML and text-embedded tool-control markers into streamed chat text.
- Treat malformed text-embedded tool calls as invalid calls so the provider retries once with corrective guidance instead of echoing raw control tokens or silently dropping them.
- Prefer required-argument retry and fallback guidance when the model emits multiple invalid tool calls in a single response.

## [0.1.20] - 2026-04-26

### Fixed

- Exclude local development-only files such as `.venv`, tests, docs, and source TypeScript from the
  published VSIX so Marketplace installs only ship the runtime extension payload.

## [0.1.19] - 2026-04-26

### Fixed

- Retry NVIDIA model responses once when they emit a required-argument tool call such as
  `read_file` with an empty JSON object, so Copilot Chat can recover instead of immediately
  surfacing a retry error to the user.

## [0.1.18] - 2026-04-26

### Fixed

- Correctly treat VS Code's groupless provider resolution as groupless when the extension host
  passes `configuration: undefined`. This prevents the legacy `nvidia-nim/<model>` model set from
  being re-registered and shown alongside `nvidia-nim/NVIDIA NIM/<model>` in Manage Models.

## [0.1.17] - 2026-04-26

### Fixed

- Stop advertising the legacy groupless NVIDIA NIM model set now that the named provider group is
  restored. This removes the duplicate `nvidia-nim/<model>` and `nvidia-nim/NVIDIA NIM/<model>`
  rows from VS Code Manage Models.
- Keep the named NVIDIA NIM group working with either its configured API key or the legacy
  SecretStorage key fallback.

## [0.1.16] - 2026-04-26

### Fixed

- Treat VS Code provider-group resolutions that only include `configuration` as provider-group
  calls, so the NVIDIA row can resolve models even when VS Code does not pass a string group name.
- Keep the duplicate-picker guard from resetting during those configuration-only group calls.

## [0.1.15] - 2026-04-26

### Fixed

- Restore legacy groupless NVIDIA NIM model identifiers such as `nvidia-nim/<model>` so stale VS
  Code model selections remain backed by the NVIDIA provider instead of falling back to Copilot.
- Keep named NVIDIA NIM provider-group models resolvable while hiding them from the picker when the
  groupless legacy entries are already visible, preventing duplicate selectable rows.

## [0.1.14] - 2026-04-26

### Fixed

- Restore broken NVIDIA NIM Manage Models entries that exist without an `apiKey` by falling back to
  the legacy SecretStorage API key for named provider groups.
- Stop hiding duplicate provider groups by returning an empty model list. Duplicate model IDs now
  remain resolvable for existing chats but are marked non-selectable so the model picker does not
  show duplicate rows.
- Reintroduce one-time legacy key migration to avoid repeatedly creating or touching VS Code model
  groups on every startup.
- Filter obvious non-chat NVIDIA catalog entries and exact duplicate model IDs from the picker cache.

## [0.1.13] - 2026-04-27

### Fixed

- **Duplicate model display (root cause fixed)**: Replaced the API-key-based duplicate guard with a
  per-resolution-cycle flag. VS Code calls `provideLanguageModelChatInformation` once per provider
  group per cycle; the extension now returns models only for the first group call in each cycle and
  suppresses all subsequent calls — regardless of whether those groups share the same API key or use
  different keys. This eliminates the duplicate model picker entries that persisted through v0.1.11
  and v0.1.12.
- **Restore Manage Models entry on startup**: Reverted the one-time migration guard introduced in
  v0.1.12. `migrateLanguageModelProviderGroup` now runs on every startup when a legacy API key is
  present, so the NVIDIA NIM entry in VS Code's Manage Models is automatically recreated if it was
  accidentally removed.

## [0.1.12] - 2026-04-27

### Fixed

- **Duplicate model display (root cause)**: Legacy API key migration is now performed only once
  per installation. Previously the migration ran on every startup, which could create multiple
  NVIDIA NIM provider groups in VS Code's Manage Models system and cause every model to appear
  twice in the model picker.
- **Diagnostic logging**: The NVIDIA NIM output channel now logs each VS Code model resolution
  call with its call number and result count. When a duplicate provider group is detected, a
  actionable warning is written to the output channel explaining how to remove the extra entry
  via VS Code Settings → Manage Models.

### How to diagnose remaining duplicate models

Open the NVIDIA NIM output channel (`View → Output → NVIDIA NIM`) and look for lines starting
with `[NVIDIA NIM] resolution:`. A `⚠️ duplicate provider group detected` message means VS Code
is still invoking your provider more than once with the same API key. Open VS Code Settings
(⌘,), search "Manage Models", find NVIDIA NIM, and remove the extra entry.

## [0.1.11] - 2026-04-26

### Fixed

- Suppress duplicate model picker entries when multiple configured NVIDIA NIM provider groups use
  the same API key.

## [0.1.10] - 2026-04-25

### Fixed

- Avoid duplicate NVIDIA NIM model picker entries by only returning models for VS Code provider
  groups that supply an API key configuration.
- Keep legacy API keys available for migration and chat fallback without advertising a second
  unconfigured copy of every model.

## [0.1.9] - 2026-04-25

### Fixed

- Mark NVIDIA NIM models as user-selectable so Copilot Chat's model picker does not filter them out.
- Treat missing NVIDIA `/models` tool-calling metadata as unknown/supported instead of unsupported, so
  chat models are still available when Copilot Chat is in Agent mode.
- Refresh stale normalized model caches when VS Code model settings provide an API key, ensuring older
  caches written before this picker metadata fix are upgraded.

## [0.1.8] - 2026-04-25

### Fixed

- Automatically migrate API keys saved by the legacy `NVIDIA NIM: Manage NVIDIA NIM API Key`
  command into VS Code's language model provider group, so Copilot Chat's model picker resolves
  NVIDIA NIM models instead of only showing the provider in settings.
- Keep the legacy SecretStorage key as a fallback while wiring it into VS Code's model configuration
  flow.

## [0.1.7] - 2026-04-25

### Fixed

- Add the VS Code language model provider configuration schema for the NVIDIA NIM API key.
- Read API keys supplied by VS Code model settings when resolving picker models and chat requests.
- Remove the deprecated model provider `managementCommand` contribution so VS Code can create a
  configured NVIDIA NIM model group.

## [0.1.6] - 2026-04-25

### Fixed

- Fetch NVIDIA NIM models on demand when the Copilot Chat model picker asks for models before the
  background refresh has populated the cache.

## [0.1.5] - 2026-04-25

### Fixed

- Clear stale cached models when NVIDIA NIM `/models` successfully returns an empty list.
- Treat non-array persisted model cache values as malformed and return no picker models.
- Update image-analysis helper comments to reflect cached vision-model selection rather than fallback behavior.

## [0.1.4] - 2026-04-25

### Fixed

- Removed the copied OpenCode Go fallback model catalog. The model picker now relies on models
  discovered from NVIDIA NIM `/models` and returns no models until a normalized NVIDIA model cache
  exists.
- Updated README and Marketplace metadata so the extension no longer advertises copied OpenCode Go
  model names.

## [0.1.3] - 2026-04-25

### Added

- NVIDIA NIM Copilot Chat provider.
- Dynamic model discovery from `https://integrate.api.nvidia.com/v1/models`.
- OpenAI-compatible streaming chat completions through NVIDIA NIM.
- Tool calling and vision capability gating based on normalized NVIDIA model metadata.
- Secure NVIDIA API key storage via VS Code SecretStorage.
- Commands for managing the API key, refreshing models, and opening debug logs.

### Changed

- Project was rebranded from the reference implementation to NVIDIA NIM.
