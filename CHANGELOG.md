# Change Log

## [Unreleased]

### Changed

- **Follow-up hardening after the Unreleased audit (`src/provider/*`, `src/api/client.ts`, `src/tools/parser.ts`, `src/models/summarizer.ts`, `src/shared/*`).** Overflow compaction now rethrows `empty_stream` / `rate_limited` / `timeout` / `network_error` instead of masking them as `context_overflow`; an exhausted `FetchAttemptBudget` no longer walks the fallback chain; summarization consumes the same budget; `maxHttpRetries: 0` means one try; empty-stream/network retries honor config instead of a hard `attempt < 2`; overflow retry restores adapter system prompts and tool token counts; text-only + image requests fail over via `model_unavailable`; thinking-only turns may fail over when no visible content was emitted; SSE `{error}` objects are classified; extracted XML parameters only fill the same tool name; native `buf.args` and incomplete XML text are capped; HTTP error bodies truncated; chat images share the 20 MiB vision cap; `emitThinkingPart` reads `reasoning.showInChat`; invalid-tool retry is a user turn; ContextLimitStore ignores implausible reported maxima; discovery keeps an in-memory catalog per API-key fingerprint.
- **Artificial Analysis Intelligence Index Documentation (`README.md`, `docs/README.md`).** Integrated verified Artificial Analysis Intelligence Index scores across all 9 curated catalog models in both `README.md` (`Supported Models` table) and `docs/README.md` (`Model Comparison Matrix`), sorting models by verified capability scores (ranging from Kimi K3 at 60 down to Nemotron 3.5 Lightning at 24).
- **Chat response orchestration (`src/provider/chat-provider.ts`, `stream-pump.ts`, `fallback-orchestrator.ts`, `overflow-compactor.ts`, `loop-breaker.ts`, `request-snapshot.ts`, `src/shared/fetch-attempt-budget.ts`).** Split the former 1752-line `provideLanguageModelChatResponse` god-method: stream consumption lives in `runStreamAttempt`, overflow compaction in `buildOverflowRetryRequest`, loop-breaker injection in `injectHistoryLoopBreaker`, and failover is an iterative loop over a shared `FetchAttemptBudget` (no recursive re-entry, no per-hop reset to 6 attempts, `consume()` never goes negative). Each stream attempt clones the baseline request body so network/tool/loop nudges cannot stack across failures.
- **Shared utilities (`src/shared/bounded-map.ts`, `proposed-apis.ts`, `json-repair.ts`, `think-tags.ts`, `tool-fields.ts`, `tool-call-ids.ts`, `src/tools/tool-kinds.ts`).** LRU `BoundedMap` for adapter + runtime-info caches; proposed `LanguageModelThinkingPart` / `LanguageModelChatToolMode` casts centralized; `parseJsonOrRepair` with a 65,536-character cap; single `THINK_TAG_PAIRS` list; shared `AUXILIARY_*` field sets; documented `tool_` / `text_tool_` id prefixes; token-based tool taxonomy (so `"thread"` is not a read tool and `"file_info"` is not an edit tool).

### Fixed

- **Prompt-injection in `repairToolArguments` (`src/tools/parser.ts`).** Stopped aliasing generic `path` onto `filePath`, stopped filling `filePath`/`cwd` from regex-extracted chat text, and capped repaired line spans at 200. Tool identifiers `__proto__` / `prototype` / `constructor` are rejected.
- **SSE buffer bounds (`src/api/client.ts`).** Partial-line buffer capped at 1 MiB; completed lines over 4 MiB are dropped. `cancelReader` now awaits `reader.cancel()` in `finally` so the socket is closed.
- **Config / resource races (`src/extension.ts`, `src/shared/logging.ts`, `src/api/key-resolver.ts`).** `onDidChangeConfiguration` invalidates runtime caches for `fallback`/`network`/`context`; output channel is a module-level handle disposed on deactivate (not `globalThis`); `_apiKeyPrompt` is assigned before await; model key binding property is non-enumerable; API keys are format-checked on save; auto-migration is skipped in untrusted workspaces; init failures surface on the status bar. Logging no longer imports `ConfigManager` (cycle broken); Bearer redaction matches 4+ character tokens and non-Bearer `Authorization` headers.
- **README version badge.** Marketplace shield is now dynamic instead of a hardcoded `v0.7.0`.

### Security

- Pinned transitive `minimist@1.2.8` via `package.json` `overrides`.

## [0.9.1] - 2026-08-27

### Added

- **`deepseek-ai/deepseek-v4-pro-0813` Integration (`src/models/catalog.ts`, `src/shared/constants.ts`, `package.json`, `tests/model-capability-matrix.test.ts`).** Added curated catalog support for `deepseek-ai/deepseek-v4-pro-0813` featuring a 1,048,576-token context window, 131,072 max output tokens, native tool calling, and streaming reasoning control via `DeepSeekAdapter` and `chat_template_kwargs` (`thinking: true`, `reasoning_effort: "high"` / `"max"`). Updated configuration schemas in `package.json` for fallback and summarization models, updated the capability test matrix, and bumped `MODELS_CACHE_VERSION=14`.

## [0.9.0] - 2026-08-26

### Added

- **`nvidia/nemotron-3-super-120b-a12b` Integration (`src/models/catalog.ts`, `src/models/adapters/nemotron-super.ts`, `src/models/adapters/index.ts`, `src/shared/constants.ts`, `package.json`, `tests/model-capability-matrix.test.ts`, `tests/model-catalog.test.ts`, `tests/model-profile.test.ts`).** Added full support for NVIDIA's LatentMoE reasoning and agentic model `nvidia/nemotron-3-super-120b-a12b` featuring a 1,000,000-token context window, 65,536 max output tokens, native OpenAI tool calling, and dedicated reasoning control via `chat_template_kwargs` (`"none"`, `"low"`, `"high"` with `low_effort: true` support). Added `NemotronSuperAdapter`, updated extension settings enums for fallback and summarization, and bumped `MODELS_CACHE_VERSION=13` to automatically refresh cached model catalogs across VS Code instances.

### Fixed

- **Cross-File Line Range Scoping & `read_file` / MCP Tool Defaulting (`src/tools/parser.ts`, `src/provider/chat-provider.ts`, `tests/tools-parser.test.ts`).** Fixed a bug in `repairToolArguments` where active editor selection line ranges (`context.startLine`, `context.endLine`) were erroneously applied to `read_file` or `view_file` calls for different files or whenever line numbers were omitted by the model. File-reading tools now consistently default to starting from line `1` (and `endLine = startLine + 499`), and editor selection line numbers are strictly scoped to edit tools operating on the matching active context file (`isMatchingContextFile`). Added bidirectional property alias resolution for MCP tools (`AbsolutePath`, `StartLine`, `TargetFile`, `CodeContent`), and decoupled `hasRetriedInvalidToolCall` in `LanguageModelChatProvider` so duplicate/invalid tool calls occurring after an auto-continue retry reliably trigger corrective feedback. Resolves #8.

## [0.8.1] - 2026-08-25

### Fixed

- **Kimi K3 Immutable Penalty Protection (`src/models/adapters/kimi.ts`, `src/models/adapters/base.ts`, `src/provider/request-builder.ts`, `tests/provider/request-builder.test.ts`).** Added adapter-level penalty capability guards (`supportsPresencePenalty: false`, `supportsFrequencyPenalty: false`). Even if a user explicitly configures `nvidia-nim.generation.presencePenalty` or `frequencyPenalty` in VS Code settings, `NimRequestBuilder` automatically suppresses these unsupported keys for Kimi K3, preventing NVIDIA NIM `HTTP 400 Bad Request` (`presence_penalty is immutable for this model and must be 0`) while still permitting `repetition_penalty`.
- **NVIDIA NIM Immutable Sampling Penalty Rejection (`src/models/adapters/nemotron.ts`, `src/models/adapters/nemotron-lightning.ts`, `src/provider/request-builder.ts`, `tests/provider/request-builder.test.ts`).** Removed hardcoded automatic default penalty injection (such as adapter-level defaults `0.15`/`0.08` and low-temp heuristics). User-configured penalty settings via `nvidia-nim.generation.frequencyPenalty`, `presencePenalty`, and `repetitionPenalty` remain fully supported and are directly forwarded to Nemotron and all other compatible models.

### Changed

- **Catalog Cleanup & Sunsetted Model De-listing (`src/models/catalog.ts`, `package.json`, `docs/README.md`, `README.md`).** Removed `thinkingmachines/inkling` from the active curated model catalog and extension fallback settings following its deprecation/sunset (HTTP 410 Gone) on NVIDIA NIM endpoints. Preserved `InklingAdapter` and its reasoning effort infrastructure in `src/models/adapters/inkling.ts` to ensure seamless zero-downtime support for any future successor models.

## [0.8.0] - 2026-08-24

### Added

- **Repetition Guard v2 with Code-Fence Awareness & History Loop Breaker (`src/provider/repetition-guard.ts`, `src/provider/chat-provider.ts`, `src/shared/config.ts`, `package.json`).** Re-introduced `RepetitionGuard` with markdown fence tracking (lines inside ` ``` ` ignored) to bound degenerate `Let me fix...` / `Let me run the test...` streaming loops without false-positive truncation on repetitive code generation. Default `nvidia-nim.generation.maxRepeatedLines=4` (0 disables). Integrated inter-turn loop detection: `detectHistoryLoop` scans last 5 assistant messages for 3+ identical preambles and `detectToolCallHistoryLoop` for 3+ identical tool calls; when detected, a breaker `system` message is injected, breaking agent-level loops that span multiple `provideLanguageModelChatResponse` invocations.
- **Sampling Penalty Controls (`src/types.ts`, `src/shared/config.ts`, `src/provider/request-builder.ts`, `package.json`).** Added `nvidia-nim.generation.frequencyPenalty` (-2..2), `presencePenalty` (-2..2) and `repetitionPenalty` (0.5..2) settings, wired through `ConfigManager.getGenerationConfig()` and `NimChatRequest`. `NimRequestBuilder` forwards penalties when explicitly configured; for low-temperature models (`temperature<=0.2`, e.g. DeepSeek `0` / GLM `0.1`) a mild default `frequency_penalty=0.2` + `presence_penalty=0.1` is applied automatically to discourage greedy verbatim loops without requiring user configuration. `repetition_penalty` is passed through to NVIDIA NIM when supported.
- **Auto-Continue on Loop/Hang (`src/shared/config.ts`, `src/provider/chat-provider.ts`, `package.json`).** Added `nvidia-nim.generation.autoContinueOnLoop` (`boolean`, default `true`) to keep the turn going instead of ending with `Stopped early`. When `RepetitionGuard` trips or the model hangs on a trailing `:` with no tool call, the provider now auto-retries once with a breaker nudge (`[NIM_LOOP_BREAKER] hey you got stuck, continue working`) instead of showing the notice; disable to restore the old notice behavior.

### Changed

- **Nemotron Hyperparameter & Prompt Calibration (`src/models/adapters/nemotron.ts`, `src/models/adapters/nemotron-lightning.ts`, `src/models/adapters/base.ts`, `src/provider/request-builder.ts`).** Kept `defaultTemperature = 1`, `toolTemperature = 1`, `defaultTopP = 0.95` per user request to preserve stochastic diversity without sacrificing coherence. Added adapter-level `defaultFrequencyPenalty=0.15`/`defaultPresencePenalty=0.08` wired via `NvidiaModelRequestProfile` and forwarded in `request-builder.ts` (precedence `modelOptions > generationConfig > adapterDefault > low-temp 0.2/0.1`) to provide mild repetition damping for Nemotron without requiring user `frequencyPenalty` config. Hardened `toolSystemMessage` to forbid preamble when a tool is needed. `RepetitionGuard` retained as safety-net (fallback, not primary) based on community feedback.
- **Scoped reasoning_content & Thinking History Support (`src/messages/converter.ts`, `src/models/adapters/kimi.ts`, `tests/model-profile.test.ts`, `tests/utils.test.ts`).** `convertMessages()` now extracts `LanguageModelThinkingPart` from assistant history into `reasoning_content`. `KimiAdapter.applyMessagesWorkaround()` was refined to strictly patch assistant messages containing `tool_calls` when `reasoning_content` is missing, eliminating dummy whitespace injection on plain text assistant turns.
- **`read_file` Argument Auto-Repair & Auxiliary Field Sanitization (`src/tools/parser.ts`, `src/messages/converter.ts`, `tests/tools-parser.test.ts`).** `repairToolArguments` now automatically provides default `startLine = 1` and `endLine = 500` (along with `mode = "full"`) when models invoke file-reading tools with an explicit `filePath` but omit line ranges. Added `startLine` and `endLine` to `AUXILIARY_REQUIRED_FIELDS` in `toModelFacingSchema` so client schemas do not force models into arbitrary line estimation, eliminating `Tool call read_file was rejected: missing startLine, endLine` retry loops during agent execution.
- **Sampling Defaults for Loop-Prone Models (`src/provider/request-builder.ts`).** Low-temp profiles (`temperature<=0.2`, e.g. DeepSeek `0`/GLM `0.1`) receive `frequency_penalty=0.2` + `presence_penalty=0.1` when no explicit penalty/`top_p` is set; Nemotron now receives `frequency 0.15/presence 0.08` via adapter defaults even though `top_p=0.95` is set (decoupled from `hasExplicitTopP`), providing root-cause damping without user config and without leaking presence when frequency is explicitly disabled (`frequencyPenaltyAutoApplied` guard).
- **Repetition Guard Hardening (`src/provider/repetition-guard.ts`, `src/provider/chat-provider.ts`).** Guard normalization is now Unicode-aware (`NFKC` + `\p{L}\p{N}`) so Cyrillic/CJK loops are caught; incomplete lines split across SSE chunks are buffered via `pendingLine` + `flush()`; fence tracking supports both ` ``` ` and `~~~` and auto-resets after `MAX_FENCE_SKIPPED_LINES=5000` to avoid being stuck on unclosed fences; `lineCounts` is bounded (`MAX_TRACKED_LINES=4096`, key truncated `MAX_KEY_LENGTH=200`); inter-turn breaker now uses stable marker `[NIM_LOOP_BREAKER]`, scans both request and history for dedup, injects as `user` (not trailing `system`), combines preamble+tool notices, and logs overflow instead of silently dropping; tool loop detection now uses canonical `buildToolCallCanonicalKey` with `sortObjectKeys` and `tryParseJsonValue` for key-order-insensitive string args.
- **Stream Idle Timeout Alignment (`src/shared/constants.ts`, `src/api/client.ts`).** `STREAM_IDLE_TIMEOUT_MIN/MAX_MS` aligned to declared `streamIdleTimeout` schema `15..600s` (was `60..300s`); adaptive idle (`maxOutputTokens/10`) now honors user `streamIdleTimeout` as a floor and clamps `configuredIdleTimeoutMs` to `MIN/MAX` to prevent silent promotion/clamping drift.

### Fixed

- **Secret Redaction in Logs (`src/shared/logging.ts`).** `debugLog/outputLog/errorLog/warnLog` now redact `Bearer` tokens, `nvapi-` keys, and sensitive object keys (`apiKey`, `authorization`, etc.) via `redactSecrets`/`redactValue` and preserve two-argument `console.*` format for test compatibility; prefixes are built lazily to survive `constants→config→logging` cyclic import (`[undefined Debug]` fix).
- **API Key InputBox Prefill (`src/extension.ts`).** `Manage API Key` no longer pre-fills `SecretStorage` value into `value` (renderer-memory exposure); uses `placeHolder` with guidance instead, preserving clear-on-empty semantics.
- **Unhandled Initialization Rejection (`src/extension.ts`).** `void initializeStoredApiKey(...).catch` now logs via `outputLog` instead of leaking an unhandled promise rejection on startup races.
- **Non-Streaming Global Timeout (`src/api/client.ts`).** `fetchModelsOrThrow`/`chatCompletion` now wrap the caller signal with `AbortSignal.timeout(NON_STREAM_REQUEST_TIMEOUT_MS=120s)` via `withRequestTimeout` + `errorForAbortedSignal` distinction so hung TCP connections surface as `timeout` (not `AbortError`) and still respect user cancellation; `readWithTimeout`/`waitForRetry` abort paths preserve `TimeoutError` reason.
- **Stream Early-Break Cancellation (`src/api/client.ts`).** `streamChatCompletion` now tracks `streamCompleted` and uses idempotent `cancelReader` (`readerCancelled` flag) so timeout-abort and breaker `break` each cancel the underlying reader exactly once; `finally` only cancels when not normally completed, fixing `cancel` call-count expectations and closing the connection on early guard trip.
- **Model ID Validation (`src/shared/config.ts`).** `sanitizeKnownModelId` validates `fallback.model`, `fallback.visionModel`, `fallback.priorityList` entries, and `context.summarizationModel` against `MODEL_LIST` with `warnLog` on unknown ids, preventing silent fallback to unavailable models and fixing `maxChainLength` overcount.
- **Surrogate-Safe Truncation (`src/messages/converter.ts`, `src/models/summarizer.ts`).** `truncatePreservingSurrogates` avoids splitting UTF-16 surrogate pairs when truncating `toolResults` (`maxToolResultChars`) and summarizer `messagesToText`/`bodyLimit`.
- **Status Bar Markdown Injection (`src/shared/status-bar.ts`).** Tooltip now uses `isTrusted=false` (no command links needed) and escapes `modelName` via `escapeMarkdown` (`[\\`*_[\]()|<>]`) to prevent table/link injection.
- **Stray Console Artifact (`tests/provider/chat-provider.stream.test.ts:524`).** Removed `console.log("TEST REPORT PART:")` mock implementation left from debugging.

## [0.7.0] - 2026-08-23

### Added

- **`moonshotai/kimi-k3` Integration (`src/models/catalog.ts`, `src/models/adapters/kimi.ts`, `tests/model-capability-matrix.test.ts`).** Added full support for the new flagship multimodal model `moonshotai/kimi-k3` featuring a 1,048,576-token context window, native tool calling, vision support, and multi-level streaming reasoning controls via top-level `reasoning_effort` (`"none"`, `"low"`, `"high"`, `"max"`).
- **Fallback Priority List (`nvidia-nim.fallback.priorityList`, `src/models/catalog.ts`, `src/provider/chat-provider.ts`).** New ordered setting (default `[]`) tried sequentially before the single `fallback.model`/`fallback.visionModel` slots. `getFallbackModel` now accepts `priorityList` and `triedModelIds`, skipping unknown, unavailable, already-tried, and the currently failing models; vision requests filter candidates by `supportsVision` with the existing last-resort vision sweep preserved. The failover engine replaced its single-hop `isFallbackAttempt` guard with depth-based chaining (`fallbackDepth`, `triedFallbackModelIds` request options), allowing up to `priorityList.length + 1` hops per request. When every candidate in the chain fails, a structured error now reports the full tried chain (`Tried chain: model-a -> model-b -> ...`) plus the last underlying error instead of surfacing a bare `rate limited`. Addresses #6.
- **Repetition Loop Guard (`nvidia-nim.generation.maxRepeatedLines`, `src/provider/repetition-guard.ts`).** Streams are monitored with a line-frequency counter over normalized answer text (lowercased, punctuation collapsed, lines under 10 significant characters ignored). When any line repeats the configured number of times (default `4`, `0` disables), further visible text is suppressed and a single markdown notice (`Stopped early: the model kept repeating the same output`) is emitted before finishing normally — bounding degenerate `Let me fix...` model loops without failing the turn.

### Removed

- **Decommissioned Model Cleanup (`src/models/catalog.ts`, `package.json`, `scripts/nim-models-probe.mjs`).** Removed `moonshotai/kimi-k2.6` (returning HTTP 404, superseded by `kimi-k3`) and `z-ai/glm-5.2` (removed from NVIDIA NIM catalog).
- **Proposed chatProvider UX Surface (`package.json`, `src/models/catalog.ts`, `src/models/discovery.ts`, `src/provider/chat-provider.ts`, `src/extension.ts`).** Dropped the entire proposed `chatProvider` API surface: the `chatProvider` entry in `enabledApiProposals`, the `nvidia-nim.ui.editToolsHint` setting, `KNOWN_EDIT_TOOLS`/`getEditToolsHint`, `getModelWarningText`, and the `isBYOK`/`statusIcon`/`warningText`/`capabilities.editTools` model metadata fields (plus their runtime gating in `mapToChatInformation` and the provider constructor). The extension now exposes only the stable model-information contract; the usage `LanguageModelDataPart` reporting for the Copilot context-window widget is unaffected.

### Changed

- **Catalog Whitelist Renaming (`src/models/catalog.ts`, `src/models/cache.ts`, `src/models/discovery.ts`, `src/tools/vision.ts`).** Renamed `ELITE_MODELS_WHITELIST` to `MODEL_LIST` across the codebase while retaining an alias for backwards compatibility.
- **Config Surface (`src/shared/config.ts`, `package.json`).** `FallbackConfig.priorityList: string[]` (sanitized: trimmed, empties/non-strings dropped, non-arrays coerced to `[]`) and `GenerationConfig.maxRepeatedLines: number` (clamped 0..50).
- **Native Context-Window Usage Reporting (`src/provider/chat-provider.ts`).** `provideLanguageModelChatResponse` now emits a terminal `LanguageModelDataPart` (MIME `usage`) carrying the OpenAI usage shape (`prompt_tokens`, `completion_tokens`, `total_tokens`) parsed from the NIM SSE stream. Copilot Chat's extension-contributed endpoint wrapper (`ExtensionContributedChatEndpoint.usageFromDataPart`) consumes this part and feeds the chat context-window widget, which previously rendered a permanent `0 / 1M tokens (0%)` for extension-contributed models. Emission is guarded (`vscode.LanguageModelDataPart.json` feature detection), skipped when the stream carries no usage numbers, and emitted exactly once per outer request — including after empty-stream retries and on the context-overflow compaction retry path; smart-fallback re-invocations report their own usage from the inner call.

## [0.6.1] - 2026-08-19

### Added

- **Vision-Aware Smart Fallback (`src/models/catalog.ts`, `src/provider/chat-provider.ts`).** Integrated capability-based fallback routing (`FallbackModelSelectionOptions`). When a failover event occurs on a request containing image inputs (`NimRequestBuilder.hasImageInput`), the system dynamically routes to a vision-capable fallback model instead of a text-only model.
- **Dedicated Vision Fallback Setting (`nvidia-nim.fallback.visionModel`).** Added configurable setting under `contributes.configuration.properties` (default: `minimaxai/minimax-m3`). If the primary `fallback.model` is text-only (e.g. `Nemotron 3.5 Lightning 30B`), image-containing requests automatically resolve to `fallback.visionModel`.
- **Fallback Collision Recovery.** If the primary failing model is itself the designated fallback model, `getFallbackModel` automatically elects the next available vision-capable model from `ELITE_MODELS_WHITELIST` (`stepfun-ai/step-3.7-flash`, `thinkingmachines/inkling`, etc.).
- **Fallback Configuration Unit & Stream Tests (`tests/config.test.ts`, `tests/model-catalog.test.ts`, `tests/provider/chat-provider.stream.test.ts`).** Added comprehensive test coverage for default and custom `fallback.visionModel` settings, multimodal fallback resolution, collision prevention, and end-to-end multimodal fallback streaming.

### Changed

- **Kimi k2.6 Deprecation Notice (`src/models/catalog.ts`, `tests/model-capability-matrix.test.ts`).** Updated `moonshotai/kimi-k2.6` display name to `Kimi k2.6 (Deprecated)` to signal server-side 404 unavailability on NVIDIA NIM while maintaining transparent failover to `minimaxai/minimax-m3`.

## [0.6.0] - 2026-08-18

### Added

- **Enterprise Configuration Schema.** Declared full configuration trees in `package.json` across `fallback.*`, `network.*`, `reasoning.*`, `generation.*`, `tools.*`, `context.*`, `ui.*`, and `developer.*`.
- **Centralized Typed ConfigManager (`src/shared/config.ts`).** Type-safe config accessors with default constants, numeric boundary clamping (e.g. `streamIdleTimeout` 15..600s, `maxHttpRetries` 0..10, `safetyMarginPercent` 0..10%), and seamless backward compatibility with legacy `reasoningMode` and `showReasoning`.
- **Configurable Network & Stream Timeouts (`src/api/client.ts`).** Integrated `ConfigManager.getNetworkConfig()` across `fetchWithRetry`, `fetchModelsOrThrow`, `chatCompletion`, and `streamChatCompletion`. Added granular `firstTokenTimeoutMs` support for early TTFT timeout detection alongside customizable `streamIdleTimeout`.
- **Dedicated Summarization Model & Context Settings (`src/models/summarizer.ts`, `src/shared/constants.ts`).** Decoupled conversation history summarization from fallback model using `nvidia-nim.context.summarizationModel`. Added dynamic `safetyMarginPercent` scaling and `autoCompactOnOverflow` guard.
- **Advanced Failover Engine & In-Chat Notice (`src/provider/chat-provider.ts`, `src/models/catalog.ts`).** Transient single-turn failover with configurable triggers (`onRateLimit`, `onModelUnavailable`, `onEmptyStream`, `onTimeout`, `firstTokenTimeoutSeconds`), custom fallback model selection (`fallback.model`), in-chat markdown callout banners (`showNoticeInChat`), and recursion depth guards ($\le 1$).
- **Generation & Tools Control (`src/provider/request-builder.ts`, `src/tools/parser.ts`).** Global sampling temperature (`generation.temperature`), nucleus sampling (`generation.topP`), maximum output cap (`generation.maxOutputTokens`), reasoning mode default (`reasoning.mode`), auto-repair toggle (`tools.autoRepairArguments`), auto-retry invalid calls toggle (`tools.autoRetryInvalidCalls`), and duplicate read suppression toggle (`tools.suppressDuplicateReads`).
- **UI & Developer Diagnostics (`src/shared/status-bar.ts`, `src/shared/logging.ts`, `src/extension.ts`).** Reactive status bar visibility toggle (`ui.showStatusBarItem`), developer debug logging integration (`developer.debugLogging`), and timing breakdown telemetry (`developer.logTimingBreakdowns`).
- **Clean Build Pipeline (`scripts/clean.mjs`).** Added zero-dependency cross-platform clean script and `"precompile"` hook in `package.json` to ensure `out/` is wiped before compilation, guaranteeing lean and artifact-free VSIX builds.
- **SEO & Marketplace Discoverability.** Expanded `package.json` keywords to target `deepseek-v4`, `nemotron`, `reasoning`, `thinking`, `agentic`, and `copilot-agent`.
- **Configuration Unit Test Suite (`tests/config.test.ts`, `tests/api.test.ts`, `tests/summarizer.test.ts`, `tests/provider/chat-provider.stream.test.ts`, `tests/provider/request-builder.test.ts`, `tests/tools-parser.test.ts`, `tests/status-bar.test.ts`).** Comprehensive tests covering defaults, boundary clamping, legacy fallback mappings, first-token timeout cancellation, dedicated summarization models, advanced failover triggers, generation hyperparameters, tool execution flags, and UI status bar visibility.

### Changed

- **Marketplace listing.** `displayName` is **NVIDIA NIM Agent**. `homepage` points at the Marketplace item, `bugs` at GitHub Issues. README now leads with an Install CTA and a native-reasoning demo GIF.

### Removed

- **Legacy `toggleShowReasoning` Command.** Removed deprecated `nvidia-nim.toggleShowReasoning` command, constant, and documentation; model reasoning is now rendered natively via VS Code's `LanguageModelThinkingPart` and controlled directly via the Copilot Chat model picker dropdown.

## [0.5.5] - 2026-08-18

### Added

- **Tag-stack XML tool scanner.** Hermes/Nemotron, Anthropic/Standard, Invoke, Qwen JSON inside `<tool_call>`, standalone `<function=name>`, and standalone `<parameter>` are parsed by a single cursor/stack in `src/tools/xml-tool-scanner.ts`. Inside a parameter, only `</parameter>` / `</tool_parameter>` ends the value, so string literals such as `const endToken = "</tool_call>";` stay in the argument instead of truncating the call.
- **Argument Fusion Engine.** Text-streamed XML parameters are merged into native tool-call JSON when the model omitted those keys.
- **Property alias resolution.** Missing required fields are filled from aliases (`filePath` <= `path`/`targetFile`/`file`/`filename`/`uri`, `content` <= `code`/`text`/`data`/`body`, `startLine` <= `start`/`fromLine`, `endLine` <= `end`/`toLine`, `path` <= `directory`/`dir`/`cwd`, `query` <= `pattern`/`regex`, `command` <= `cmd`/`script`).
- **Narrow terminal repair.** For terminal/command tools only, a missing `goal` is copied from `explanation` (or a short `Run: …` prefix of `command`), a missing `explanation` is copied from `goal`, and a missing `mode` uses the first schema enum or `sync`. Missing file payloads and MCP fields are not invented.
- **Native tool contract.** Requests with tools always send `tool_choice: "auto"` (unless Copilot requires a tool). Model-facing schemas drop auxiliary required fields (`goal`, `explanation`, `mode`, …) and keep short descriptions so NIM's server-side parser is more likely to emit real `tool_calls` instead of XML in `content`.
- **Repeat terminal commands.** Historical duplicate suppression applies only to idempotent reads. `run_in_terminal` / write / edit may run again with the same arguments (for example compile after a failed build).
- **Search tools keep going.** Missing `isRegexp` defaults to `false`. `grep` / `search` / `find` are not treated as historical duplicates. Repair/duplicate guidance is sent back to the model as a retry turn, not printed in the user chat.
- **Native stream tool-call normalization.** `delta.tool_calls` and final `message.tool_calls` accept object arguments, missing ids, JSON strings, and index-keyed maps. An empty `tool_calls: []` no longer counts as a real call. `finish_reason: tool_calls` with no payload now retries once even after thinking, then surfaces a fallback instead of a silent turn. Duplicate same-argument calls are recorded as skips instead of disappearing.
- **Extended thinking tags.** The reasoning filter recognizes `<thought>`, `[THINK]`, and `<reasoning>`.

### Fixed

- **Tag-literal collision.** Non-greedy regex over a whole `<tool_call>…</tool_call>` no longer cuts file edits that contain `</tool_call>` or `</function>` in source. Quoted and regex literals such as `const token = "<tool_calls>";` or `/^\s*<\/tool_calls>/` are left as source text so the parser no longer swallows the token and dumps `";` plus the rest of the file into chat.
- **Markdown code fence protection & stream chunk buffering.** XML inside ` ``` ` fences is left as text. In-flight tool tags split across SSE chunks stay in `incompleteText` until they close.
- **XML and control token leak prevention.** Orphan tool close tags and Llama/ChatML/GLM control tokens are stripped from visible text, not from parameter values.
- **Source code string literal collision protection.** `getIncompleteTextToolCallName` only accepts `/^[a-zA-Z0-9_.-]{1,64}$/` identifiers.
- **Stringified JSON tool arguments repair.** Malformed array/object argument strings are repaired with `jsonrepair`.
- **Fallback on HTTP 404 Model Unavailable.** Fail over to `nvidia/nemotron-3.5-lightning-30b-a3b`.
- **Deduplicated error traces in VS Code UI.**

### Tests

- Parser tests for Hermes/Anthropic/Qwen XML, standalone parameters, argument fusion, aliases, fence protection, multi-chunk buffering, `</tool_call>` / `</function>` collisions, split `newString` chunks, terminal `goal` copy, and refusal to invent `content` or `rollbackOnFailure`.
- Extended `tests/utils.test.ts` for extra think-tag pairs.
- Stream tests for HTTP 404 failover onto Lightning.

## [0.5.4] - 2026-08-17

### Added

- **DeepSeek V4 Flash 0731.** NVIDIA withdrew the previous DeepSeek V4 Flash and V4 Pro endpoints. The catalog now ships `deepseek-ai/deepseek-v4-flash-0731` (picker name **DeepSeek V4 Flash 0731**) with the same 1,048,576-token window, 131,072-token output limit, tool calling, and `None` / `High` / `Max` reasoning modes.
- **Nemotron 3.5 Lightning 30B.** Added `nvidia/nemotron-3.5-lightning-30b-a3b` as a compact 30B/3B-active text model: 1,000,000-token context (confirmed by the live 1,048,576-token probe, which the hosted API rejected at exactly 1,000,000), 32,768-token output, tool calling, no vision. A dedicated adapter is registered ahead of the generic Nemotron adapter because Lightning uses `chat_template_kwargs.enable_thinking` plus `reasoning_budget`, not Ultra's `reasoning_effort`.
- **OpenRouter-style Lightning reasoning budgets.** Picker modes are `None` / `Medium` / `High` / `XHigh`. They map to `reasoning_budget` 0 / 50% / 80% / 95% of the request `max_tokens`, capped at 32,768. `None` sends `enable_thinking: false`.
- **HTTP 529 capacity fallback.** NVIDIA's `529 Overloaded` (`Service temporarily overloaded`) is classified as a retryable `rate_limited` error instead of a generic 5xx. After retries fail, the same Lightning fallback used for HTTP 429 fires, with an `Overloaded on …` notification.

### Changed

- **Rate-limit and summarizer fallback is Lightning.** DeepSeek Flash is no longer the automatic fallback: it is itself the model that is currently overloaded. `FALLBACK_MODEL_ID` is `nvidia/nemotron-3.5-lightning-30b-a3b` for both 429/529 recovery and conversation summarization. Lightning's 1M window is large enough to summarize an overflowed elite-model thread.
- **Isolated content-only replies stay visible.** When High/Max (or any isolated reasoning mode) is on but the model never emits `reasoning_content` or think tags, the reply is no longer stuffed into a `ThinkingPart` and no longer fails as `[EMPTY_STREAM]`. Untagged content is buffered until the stream ends or a reasoning signal appears; only then is it classified as thinking or as the answer.
- **Answer tokens stream after reasoning.** Once `reasoning_content` has finished, each `content` delta is flushed to the chat immediately. Previously the router held the answer until 150 characters or `</think>`, and the provider refused to flush text until `answerStarted`, so the whole answer appeared in one dump after the stream ended. An in-chunk `</think>` still splits leaked reasoning from the visible answer.
- **Model cache invalidated.** `MODELS_CACHE_VERSION` is 12 so stale Flash / Pro / old Lightning limits are dropped on the next refresh.

### Removed

- **DeepSeek V4 Flash (`deepseek-ai/deepseek-v4-flash`) and DeepSeek V4 Pro.** Both IDs are gone from NVIDIA NIM and from the curated whitelist, capability matrix, model-list probe, and README.

### Tests

- Extended the curated capability matrix for Flash 0731 and Lightning, including OpenRouter budget percentages and content-only High visibility.
- Added live 429/529 fallback coverage onto Lightning, 529 classification/retryability, and post-reasoning streamed text parts (`Hel` / `lo ` / `world`).
- Replaced leftover V4 Pro / old Flash fixtures so discovery, refresh, and picker tests use current whitelist IDs.

## [0.5.3] - 2026-08-16

### Changed

- **Safer adapter access.** The chat provider now uses optional chaining (`adapter?.`) instead of a non-null assertion when reading adapter hooks, so a missing adapter falls back to the shared tool-call parser instead of throwing.
- **`no-explicit-any` is an error.** `@typescript-eslint/no-explicit-any` is enforced as `error` so `as any` cannot land in `src/` or `tests/` unnoticed.
- **Shared test factories.** VS Code doubles (`makeToken`, `makeModel`, `makeMessages`, `makeChatOptions`, and related helpers) live in `tests/helpers/fakes.ts`. Call sites no longer use `as any` / `as unknown as` casts.
- **TypeScript target ES2022.** `tsconfig.json` `target` and `lib` moved from ES2020 to ES2022, matching `vscode ^1.125` and Node 22.

### Removed

- **Dead production APIs.** Removed unused `stripThinkTags`, `StatusBarManager.showUsage`, and `ContextLimitStore.clearForModel`, plus the unreachable token-classification fallback in `classifyPartTokens`.
- **Unused vision header parse.** `measureImageDataUrl` now returns only the decoded byte length; the unused MIME-type field is gone.

## [0.5.2] - 2026-08-14

### Added

- **Fetch-attempt budget.** Every response now shares a `MAX_TOTAL_FETCH_ATTEMPTS` connection budget across all of its stream attempts (initial tries, empty-stream, network, and context-overflow retries). Nested retry layers previously multiplied into ~9+ requests against a rate-limited endpoint; the observed worst case is now capped.
- **Overflow retry preserves tool calls and reasoning.** When a context-overflow compaction retry is issued, streamed `tool_calls` are aggregated and emitted instead of being silently dropped, and `reasoning_content` is surfaced as thinking parts. Tool results in the compacted history are now truncated (`maxToolResultChars`) and vision content is preserved via the same conversion options as the primary request.
- **Vision input validation.** The `nvidia_nim_analyze_image` tool now requires a base64 image data URL (`data:image/...;base64,...`) and rejects remote URLs and oversized payloads (max 20 MB) before any API access.
- **Clickable token breakdown.** The status bar keeps its refresh command active after showing the token-usage breakdown instead of becoming inert.
- **Retry budget test coverage.** Added provider/client tests for the fetch budget, the overflow-retry tool/reasoning paths, `max_tokens` error classification, network-retry message role, empty summarizer fallback, and circular log payloads.

### Changed

- **Context-overflow detection narrowed.** The overly broad `/max.*token/i` pattern was replaced with anchored variants requiring an explicit excess or limit. HTTP 400 validation errors such as `invalid value for 'max_tokens'` are no longer misclassified as `context_overflow`, avoiding needless history compaction and retries.
- **Rate-limit fallback detected by type.** The DeepSeek Flash fallback now fires on `NvidiaApiError` with `kind === "rate_limited"` instead of string-matching `[RATE_LIMITED]`.
- **Network-retry message role.** The guidance injected after a mid-stream network failure is now sent as a `user` turn, which is universally accepted by OpenAI-compatible backends, instead of a trailing `system` message.
- **Cryptographic tool-call IDs.** Generated tool-call IDs now use `crypto.randomUUID()` instead of `Math.random()`.
- **Empty summaries fall back to truncation.** If the summarizer returns an empty response, the previous-context fallback truncation is used instead of inserting an empty `[Previous conversation summary]`.
- **Logging resilience.** `debugLog`/`outputLog`/`warnLog`/`errorLog` no longer throw on circular payloads.
- **Token estimates consistent.** Unknown message parts contribute a placeholder token count in category breakdowns, matching `estimatePartTokens`.

### Removed

- **Dead code.** Removed the unused `TokenCounter` module, `validateRequest` and `tryParseJSONObject` from the message converter, and the duplicated `SkippedToolCall` interface in the tool-call aggregator.

## [0.5.1] - 2026-08-13

### Added

- **Muse Glimmer 30B support.** Added `meta/muse-glimmer-30b` with a 131,072-token context window, 32,768-token maximum output, vision input, tool calling, and reasoning efforts (`None` / `Low` / `Medium` / `High` / `XHigh`) sent via `reasoning_effort`.
- **Muse Glimmer model adapter.** Added model-specific request configuration (`temperature: 1`, `reasoning_effort` parameter format) and direct-content reasoning routing.

### Removed

- **Laguna XS 2.1 support.** Removed `poolside/laguna-xs-2.1` from the curated catalog, along with its model adapter, response control-marker sanitization, and related regression tests.

## [0.5.0] - 2026-07-29

### Added

- **Empty-stream recovery.** The provider now detects when a streamed completion finishes without surfacing any user-visible answer (`LanguageModelTextPart`) or tool call (`LanguageModelToolCallPart`). Fully empty streams (no reasoning, no content, no tool calls) are automatically retried up to two times within the existing attempt loop before failing.
- **`empty_stream` structured error.** New `EMPTY_STREAM` error kind in `ERROR_MESSAGES` (`src/api/errors.ts`) replaces the previous silent resolution that produced Copilot Chat's `Sorry, no response was returned` placeholder. The final message includes the model name, attempt count, whether reasoning was emitted, and the last observed `finish_reason`.
- **Visible-vs-thinking response tracking.** Introduced per-attempt `reportedVisibleContent` and outer `hasReportedVisibleContent`, distinct from `reportedContent`/`hasReportedContent`. Only text and tool-call parts count as a visible answer; thinking parts no longer mask an empty turn as success.
- **Outer tool-intent guard.** New `sawToolCallOverall` flag tracks any streamed, text-embedded, invalid, or incomplete tool call across attempts so suppressed-duplicate and invalid-tool turns are not misclassified as an empty stream.
- **Stream-end diagnostics.** `stream timing` and the new `stream finished` debug logs now record `reportedVisibleContent`, `sawReasoning`, `lastFinishReason`, `streamChunkCount`, `willRetryEmptyStream`, and `emptyStreamRetryCount`; a dedicated `emptyStreamRetry` log line is emitted on each empty-stream retry.

### Changed

- **Reasoning-only turns fail fast.** A turn that emits only `reasoning_content`/thinking with no answer or tool call (e.g. an NVIDIA NIM server-side stall mid-thinking) now raises `[EMPTY_STREAM]` immediately instead of being treated as a successful response. It is deliberately not multi-retried, to avoid compounding multi-minute stalls at `temperature: 0`.
- **Empty-stream retry scope.** The empty-stream retry condition requires `!sawReasoning && !sawToolCall && !reportedVisibleContent && !emittedToolCall`, keeping it independent of the network-error and invalid-tool-call retry paths.

### Fixed

- **Silent `no response` on aborted streams.** Aborted or empty NVIDIA NIM streams no longer resolve without output; they retry or surface a structured error so Copilot Chat always receives either content or a real failure.
- **Pre-existing lint failures.** Resolved 17 eslint errors across `src/provider/chat-provider.ts`, `src/api/errors.ts`, `src/provider/request-builder.ts`, and `tests/context-window-overflow.test.ts` (prettier formatting, `prefer-const`, and removal of dead `safetyMargin`/`requestBody` locals). `eslint src/ tests/ --quiet` now reports zero errors.

### Removed

- Deleted stale planning documents `CONTEXT_WINDOW_PLAN.md` and `CONTEXT_WINDOW_FIX_PLAN.md`, and the superseded `release-notes-0.4.10.md`.

### Tests

- Added empty-stream recovery coverage: a fully empty stream retries then throws `[EMPTY_STREAM]`, and a retry that returns content recovers cleanly.
- Updated reasoning-only stream tests to assert the new `[EMPTY_STREAM]` failure (single attempt, no multi-retry) while preserving thinking-part routing assertions.
- Verified TypeScript compilation, `eslint --quiet` (0 errors), and the full Jest suite (478 tests).

## [0.4.10] - 2026-07-27

### Added

- **Runtime context-limit store.** Server-reported context limits from HTTP 400 errors are now cached per model and API-key fingerprint. Subsequent requests automatically use `min(catalog, runtime)` as the effective budget, preventing repeated overflows without modifying the curated catalog.
- **Complete curated-model capability matrix.** Declared reasoning, tool-calling, vision, context-window, output-limit, and adapter behavior for every bundled NVIDIA NIM model.
- **Hardened model and credential infrastructure.** Added shared API-key resolution for provider groups and legacy secret storage, plus versioned model-cache ownership, migration, atomic persistence, refresh, and bounded LRU behavior.

### Changed

- **Exact NVIDIA context windows.** Updated the curated catalog with endpoint-reported limits, including 202,752 tokens for GLM 5.2, 524,288 for MiniMax M3, and 1,000,000 for Nemotron 3 Ultra; retained a 1,048,576-token window for Inkling, and invalidated stale model caches.
- **Model-card output limits.** Aligned `maxOutputTokens` with model-card specifications: DeepSeek V4 Flash/Pro 131,072, GLM 5.2 131,072, Step 3.7 Flash 262,144, Laguna XS 2.1 65,536.
- **Reliable streaming and tool execution.** Improved split SSE delta and function-name assembly, malformed and truncated tool-call repair, JSON Schema validation, type normalization, duplicate suppression, and tool-result conversion.
- **Abortable API lifecycle.** Centralized NVIDIA API errors and made retries, backoff, cancellation races, response-body cleanup, prompt locking, and rate-limit fallbacks cancellation-aware.
- **Accurate context accounting.** Corrected prompt compression, retry output limits, image and tool-result estimates, and actual-versus-estimated status-bar usage.
- **Lean reproducible packaging.** Standardized CI on npm and package only the minimal `jsonrepair` runtime dependency required by the extension.

### Fixed

- **Context-overflow parser mis-extraction.** The `"your messages resulted in N tokens"` NVIDIA NIM error format previously captured the reported maximum as the actual usage. A dedicated `resulted in` regex now extracts both values correctly.
- **Context-overflow retry loop.** Added a `hasRetriedContextOverflow` guard so the compact-and-retry path executes at most once per request, even if the retry also returns HTTP 400.
- **Structured overflow failure message.** Final context-overflow errors now include the model name, server-reported limit, and actual prompt token count for actionable diagnostics.
- **API-key isolation and fail-closed bindings.** Removed raw credentials from model metadata and normal logs; ambiguous or stale provider bindings no longer fall through to an unrelated key. Chat, summarization, and vision now use the same resolver.
- **Vision tool contribution.** Declared `nvidia_nim_analyze_image` in `contributes.languageModelTools`, so VS Code registers it before extension activation.
- **Current vision-model selection.** Refresh and cache updates can no longer leave vision requests bound to an obsolete model.

### Tests

- Added a public `/v1/models` metadata probe and calibrated context-window probes for 262,144, 500,000, and 1,048,576 tokens.
- Recorded live probe outcomes: confirmed 202,752 for GLM 5.2, 524,288 for MiniMax M3, and 1,000,000 for Nemotron 3 Ultra; Inkling and both DeepSeek V4 variants returned service errors, while Kimi K2.6 returned an account-level 404.
- Added parser tests for the `"resulted in"` error format across 202,752 / 262,144 / 524,288 / 1,000,000 limits, plus unrelated-400 rejection and `classifyApiError` integration.
- Added `ContextLimitStore` unit tests: round-trip, per-model isolation, API-key invalidation, and clear semantics.
- Synchronized catalog test expectations with updated model-card output limits.
- Expanded regression coverage for API-key resolution, model capabilities and refresh, request building, streaming adapters, tool parsing, cancellation, token accounting, summarization, and extension activation.
- Verified TypeScript compilation, formatting, packaging, all 475 Jest tests, isolated VSIX installation, and a real VS Code Extension Host activation smoke test.

## [0.4.9] - 2026-07-23

### Fixed

- **VSIX package size.** Excluded the development-only `.mimocode` directory from Marketplace packages, reducing the extension archive from roughly 12 MB to under 600 KB.

## [0.4.8] - 2026-07-23

### Added

- **Laguna XS 2.1 support.** Added `poolside/laguna-xs-2.1` with a 262,144-token context window, 16,384-token maximum output, and model-specific reasoning controls (`None` / `On`).
- **Laguna and Inkling model adapters.** Added model-specific request configuration and streaming response handling for reasoning, tool calls, and control markers.

### Fixed

- **Laguna responses were incorrectly hidden as thinking.** Plain content-only responses now render as assistant text when no separate reasoning stream is present.
- **Reasoning boundary parsing.** Preserved `<think>` blocks and orphaned `</think>` boundaries while preventing control markers from leaking into final answers.
- **Unavailable model errors.** NVIDIA `404` responses now identify the unavailable model and distinguish endpoint access problems from Copilot status indicators.

### Tests

- Added regression coverage for Laguna content-only responses, reasoning boundaries, model profiles, and unavailable-model API errors.

## [0.4.7] - 2026-07-17

### Added

- **Integration for `thinkingmachines/inkling`.** Added Inkling to the curated NVIDIA NIM model catalog with a 1,000,000-token context window, a configured 65,536-token maximum output, vision support, and tool calling.

### Changed

- **Model catalog cache refresh.** Bumped the model cache version so existing installations refresh their cached catalog and discover Inkling without requiring a manual reset.

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
