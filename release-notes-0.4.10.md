# v0.4.10

## What's New

- **Automatic context-window recovery.** When NVIDIA NIM rejects a request with a server-reported context limit (HTTP 400), the extension now parses the exact limit, caches it for the model, compacts the conversation history, and retries once automatically. Subsequent requests use the discovered limit proactively, so long Copilot Chat sessions no longer fail repeatedly on the same overflow.
- **Fixed overflow parser bug.** The `"your messages resulted in N tokens"` error format previously mis-extracted the actual token count. Both the reported maximum and actual usage are now parsed correctly.
- **Retry-once guarantee.** Context-overflow compaction and retry now execute at most once per request, eliminating the possibility of a retry loop on persistent 400 responses.
- **Model-card output limits.** Aligned `maxOutputTokens` with model-card specifications for DeepSeek V4 Flash/Pro (131,072), GLM 5.2 (131,072), Step 3.7 Flash (262,144), and Laguna XS 2.1 (65,536).
- **Better error diagnostics.** Final context-overflow errors now include the model name, server-reported limit, and actual prompt token count.
- **Complete curated-model capability matrix.** Declared reasoning, tool-calling, vision, context-window, output-limit, and adapter behavior for every bundled NVIDIA NIM model.
- **Hardened model and credential infrastructure.** Added shared API-key resolution for provider groups and legacy secret storage, plus versioned model-cache ownership, migration, atomic persistence, refresh, and bounded LRU behavior.
- **Exact NVIDIA context windows.** Updated the curated catalog with endpoint-reported limits, including 202,752 tokens for GLM 5.2, 524,288 for MiniMax M3, and 1,000,000 for Nemotron 3 Ultra; retained a 1,048,576-token window for Inkling, and invalidated stale model caches.
- **Reliable streaming and tool execution.** Improved split SSE delta and function-name assembly, malformed and truncated tool-call repair, JSON Schema validation, type normalization, duplicate suppression, and tool-result conversion.
- **Abortable API lifecycle.** Centralized NVIDIA API errors and made retries, backoff, cancellation races, response-body cleanup, prompt locking, and rate-limit fallbacks cancellation-aware.
- **Accurate context accounting.** Corrected prompt compression, retry output limits, image and tool-result estimates, and actual-versus-estimated status-bar usage.
- **Lean reproducible packaging.** Standardized CI on npm and package only the minimal `jsonrepair` runtime dependency required by the extension.

## Fixes

- **API-key isolation and fail-closed bindings.** Removed raw credentials from model metadata and normal logs; ambiguous or stale provider bindings no longer fall through to an unrelated key. Chat, summarization, and vision now use the same resolver.
- **Vision tool contribution.** Declared `nvidia_nim_analyze_image` in `contributes.languageModelTools`, so VS Code registers it before extension activation.
- **Current vision-model selection.** Refresh and cache updates can no longer leave vision requests bound to an obsolete model.

## Install

Download the `nvidia-nim-agent-0.4.10.vsix` file and install it from the VS Code Extensions view using **Install from VSIX...**
