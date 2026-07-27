# Context Window Auto-Fix Plan

## Goal

Prevent long VS Code Copilot Chat sessions from failing when NVIDIA NIM enforces a smaller context window than the curated model metadata or model card suggests.

## Scope

- Handle NVIDIA NIM `400` responses that explicitly report a maximum context length.
- Apply the discovered limit to the current runtime request and model instance.
- Compact the request and retry once with the corrected budget.
- Keep curated catalog values unchanged unless a separately verified catalog update is made.

## Implementation steps

1. **Parse the server error.** Add a narrow parser for messages matching the NIM context-length error. Extract `reportedMaximumContextTokens` and, when present, the actual prompt token count. Ignore unrelated `400` responses.
2. **Keep a runtime override.** Store the discovered limit by model ID and provider/deployment identity. Do not persist it as authoritative catalog metadata after a single failure. Expire or clear it when the provider key/deployment changes.
3. **Calculate an effective budget.** Use `min(catalogWindow, runtimeOverride)` and reserve output tokens plus a safety margin. Include system messages, history, tool schemas, tool results, images, and the current user turn in the estimate.
4. **Compact before retry.** Preserve system/developer instructions, the active user turn, and complete tool-call/result pairs. Remove or summarize the oldest turns until the estimated request fits the effective budget.
5. **Retry once.** Rebuild the request with the smaller context and adjusted output limit. Mark the retry so the same request cannot enter a retry loop.
6. **Surface a final failure.** If the retry still fails, show the model, reported limit, estimated usage, and an actionable suggestion to start a new chat or reduce attachments. Preserve the original server error for diagnostics.
7. **Avoid cross-request races.** Serialize runtime-limit updates per model and make cancellation abort parsing, compaction, and retry cleanly.

## Tests

- Parse valid NIM errors for `202752`, `262144`, `524288`, and `1000000`.
- Ignore malformed errors, unrelated `400` responses, and limits larger than the configured catalog value unless explicitly allowed.
- Compact histories at 80%, 90%, exact-limit, and over-limit boundaries.
- Preserve system prompts, the active turn, and tool-call/result pairing.
- Retry exactly once after a context error; never loop on repeated `400` responses.
- Verify runtime overrides are isolated by model and cleared when the provider key changes.
- Verify cancellation during compaction and retry does not send another request.
- Verify image and tool-result estimates use the same budget as normal requests.

## Rollout criteria

- No request is sent when local accounting proves it exceeds the effective budget.
- A server-reported lower limit results in one automatic compact-and-retry attempt.
- The curated catalog is not silently rewritten from an unverified runtime error.
- Existing streaming, tool execution, summarization, and cancellation tests remain green.
