# Context Window Overrun Analysis Plan

## Findings to date

| Model | Endpoint result | Catalog value | Confidence |
| --- | ---: | ---: | --- |
| `poolside/laguna-xs-2.1` | 262144 accepted | 262144 | Confirmed |
| `stepfun-ai/step-3.7-flash` | 262144 accepted | 262144 | Confirmed |
| `z-ai/glm-5.2` | 202752 reported by API | 202752 | Confirmed |
| `minimaxai/minimax-m3` | 524288 reported by API | 524288 | Confirmed |
| `nvidia/nemotron-3-ultra-550b-a55b` | 1000000 reported by API | 1000000 | Confirmed |
| `thinkingmachines/inkling` | HTTP 500 at 1048575 prompt tokens | 1048576 | Unverified; service error |
| `deepseek-ai/deepseek-v4-flash` | HTTP 503/504 during calibration | 1048576 | Unverified; service timeout |
| `deepseek-ai/deepseek-v4-pro` | HTTP 504 during calibration | 1048576 | Unverified; service timeout |
| `moonshotai/kimi-k2.6` | HTTP 404; function unavailable to account | catalog value | Unverified; access error |

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
