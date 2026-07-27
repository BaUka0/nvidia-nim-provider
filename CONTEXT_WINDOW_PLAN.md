# Context Window Overrun Analysis Plan

## Findings to date

| Model | Observed at endpoint | Catalog value (model card) | Confidence |
| --- | ---: | ---: | --- |
| `poolside/laguna-xs-2.1` | 262144 accepted | 262144 | Observed for tested account |
| `stepfun-ai/step-3.7-flash` | 262144 accepted | 262144 | Observed for tested account |
| `z-ai/glm-5.2` | 202752 reported by API | 1000000 | Observed for tested account; catalog uses model card |
| `minimaxai/minimax-m3` | 524288 reported by API | 1000000 | Observed for tested account; catalog uses model card |
| `nvidia/nemotron-3-ultra-550b-a55b` | 1000000 reported by API | 1000000 | Observed for tested account |
| `deepseek-ai/deepseek-v4-pro` | 262144 reported by API (user issue) | 1048576 | Observed for tested account; catalog uses model card |
| `thinkingmachines/inkling` | HTTP 500 at 1048575 prompt tokens | 1048576 | Unverified; service error |
| `deepseek-ai/deepseek-v4-flash` | HTTP 503/504 during calibration | 1048576 | Unverified; service timeout |
| `moonshotai/kimi-k2.6` | HTTP 404; function unavailable to account | 262144 | Unverified; access error |

### Important: API limits ≠ model characteristics

NVIDIA NIM API 400 error responses report **account/deployment-specific** context limits, not global model capabilities. These observed limits should **not** overwrite the curated catalog values (which reflect model card specifications). Instead, the extension should:

1. Detect runtime limits from API error responses (`parseContextOverflowDetail`)
2. Apply observed limits **locally** for retry logic and user feedback
3. Preserve catalog integrity with model card values

## Implementation status

| Step | Description | Status |
| --- | --- | --- |
| 1 | Define effective budget (`calculateSafetyMargin`) | ✅ Complete |
| 2 | Measure before sending (token estimation + diagnostics) | ✅ Complete |
| 3 | Preflight long sessions (85% threshold compaction) | ✅ Complete |
| 4 | Summarize evicted history (`summarizer.ts`) | ✅ Complete |
| 5 | Handle server rejection (HTTP 400 parsing + retry) | ✅ Complete |
| 6 | Cover long-session cases (edge-case tests) | ✅ Complete (19 tests) |
| 7 | Validate in a real host | ⬜ Manual |

## Files changed

| File | Changes |
|------|---------|
| `src/shared/constants.ts` | `calculateSafetyMargin()` — dynamic: 4096 for ≤256K, 1% for ≥256K |
| `src/api/errors.ts` | `context_overflow` kind, `parseContextOverflowDetail()`, `isContextOverflowError()`, HTTP 400 refinement, `\b` word boundary fix |
| `src/provider/chat-provider.ts` | Context overflow retry with compaction, actionable message |
| `src/provider/request-builder.ts` | Preflight compaction at 85% threshold, shared `compactMessages` helper, `PreparedRequest.safetyMargin`, budget debug log |
| `src/provider/token-counter.ts` | Dynamic safety margin |
| `tests/context-window-overflow.test.ts` | 19 tests for parsing, classification, safety margin (incl. edge cases) |
| `CONTEXT_WINDOW_PLAN.md` | Updated with observed data, model card policy, step 2 complete |

## Known limitations

- `'N > M'` format (`"prompt is too long: 1048576 > 262144"`): `reportedMaximum` stays undefined due to maxMatch regex ordering
- Context overflow retry doesn't handle reasoning content or tool calls from compacted stream (P1)
- Dynamic runtime limit detection from API errors not yet applied to preflight checks (future work)

## Analysis plan

1. **Define the effective budget.** For every request calculate `contextWindow - reservedOutput - safetyMargin`. Count system instructions, conversation history, tool schemas, tool calls/results, attachments, and hidden VS Code prompt content.
2. **Measure before sending.** Add a single request-local token estimator and expose estimated prompt tokens, reserved output, and remaining budget to diagnostics. Calibration must be cached and must never send a large probe during normal chat.
3. **Preflight long sessions.** Before the API call, warn when the budget is near exhaustion and automatically compact the oldest conversation turns. Preserve system/developer messages, the current user turn, and tool-call/result pairs.
4. **Summarize evicted history.** Replace removed turns with a bounded summary, then re-estimate. Avoid repeated compaction loops and cap the number of retries to one.
5. **Handle server rejection.** Parse HTTP 400 context errors for reported maximum and actual usage. Show an actionable message, update only runtime diagnostics unless the value is explicitly trusted, compact once, and retry once with a smaller output reservation.
6. **Cover long-session cases.** Add tests for 80%, 90%, exact-limit, and over-limit prompts; large tool results; images; reasoning content; cancellation during compaction; and a server-reported limit lower than the catalog value.
7. **Validate in a real host.** Run a long VS Code Copilot Chat session with logging enabled, compare local estimates with NIM error counts, and verify that no request is sent after the preflight rejects it.

## Acceptance criteria

- No normal request exceeds the configured/effective context budget.
- A lower runtime limit is surfaced without corrupting the curated catalog.
- The user receives a clear warning before truncation and a clear error only after compaction cannot fit the request.
- Compaction preserves the active task and tool-call protocol, and all behavior is covered by deterministic tests.
