# Deep best-practices review — nvidia-nim-provider (September 2026)

A fresh SOLID / DRY / KISS / YAGNI / OCP / LSP pass over `main`, run after the
previous review-and-refactor cycle (catalog-keyed adapters, turn executor,
unified compaction). This file replaces `docs/best-practices-review.md` and
`docs/best-practices-status.md`.

**Update:** the High and Medium findings below were fixed in the follow-up
pass on the same day (marked **[fixed]**). Remaining open items are marked
**[open]** with the reason they were left alone.

Method: full read of `src/api`, `src/messages`, `src/models`, `src/provider`,
`src/shared`, `src/tools`, `extension.ts`, `package.json` and the test tree,
cross-checked against the previous review's claims. Everything below cites
post-pass line numbers.

The cheap fixes found along the way were **applied in this same pass**; they are
listed under "Fixed in this pass" and described in `CHANGELOG.dev.md`
(`## [Unreleased]`). Everything in "Open findings" is deliberately not fixed
here — it is behavior-adjacent restructuring that deserves its own pass.

---

## Verdict

The architecture is sound and the previous pass landed as claimed. What remains
is concentrated in three places:

| File | Lines | Residual risk |
|---|---|---|
| [src/provider/turn-executor.ts](../src/provider/turn-executor.ts) | 938 | `executeTurn` is still a ~700-line method with a hidden state machine |
| [src/api/client.ts](../src/api/client.ts) | 672 | SSE parse loop and abort-race handling duplicated internally |
| [src/tools/xml-tool-scanner.ts](../src/tools/xml-tool-scanner.ts) | 610 | protocol complexity is load-bearing; only internal helpers overlong |

The single biggest open item is **retry policy as boolean soup** inside
`executeTurn`. Everything else is either mechanical (dedup, dead code) or
load-bearing (multi-protocol parsing).

---

## Verified: the previous pass's claims hold

- `scripts/sync-manifest.mjs` syncs `package.json` enums/defaults and the probe
  script from `MODEL_LIST`; `tests/model-catalog.test.ts:355` asserts all four
  enums and all three defaults match the catalog. Shotgun surgery on model
  addition is gone.
- Adapter dispatch is catalog-keyed (`ADAPTERS_BY_ID` in
  `src/models/adapters/index.ts`); the family regex is fallback-only.
- Parser split (`tool-schema`, `request-context`, `argument-repair`,
  `canonical-key`) and converter split (`parts`, `token-estimate`) are real;
  `parser.ts` is a barrel.
- Nemotron family and reasoning-effort adapters are deduplicated
  (`NemotronFamilyAdapter`, `ReasoningEffortAdapter`).
- Config snapshot exists for the turn hot path: `executeTurn` receives
  `NimConfig`; stream pump and request builder take their values as inputs;
  `api/client.ts` reads no workspace config.

---

## Fixed in this pass (summary)

Details and file touchpoints are in `CHANGELOG.dev.md`. In short:

1. **Dead adapter contract removed.** `alwaysReasons` (never set), the
   `"always-isolated"` routing branch, `sanitizeResponseText` (never
   implemented) and the `responseSanitization` contract field,
   and the `parseTextEmbeddedToolCalls` adapter indirection (no adapter ever
   overrode it; the pump now calls the shared parser directly, and the pump's
   `adapter` input field is gone with it).
2. **Ghost adapters deleted** (`glm.ts`, `stepfun.ts`, `inkling.ts`). They had
   no `MODEL_LIST` entry, and discovery filters every model id through
   `MODEL_LIST` (`src/models/catalog.ts:196`), so the family-regex fallback
   could never reach them in production. Concrete adapter class re-exports were
   dropped from `adapters/index.ts`.
3. **Dead exports removed.** Aggregator getters `getEmittedToolCall` /
   `getRequestContext` / `getEmittedTextToolCallKeys` (zero callers after the
   previous encapsulation pass) plus a point lookup `getToolSchema(name)`;
   `repetitionNoticeSent` result field; `detectCycleHint`/`detectPhraseCycle`
   re-exports from `turn-report` and `repetition-guard`;
   `CONTEXT_WINDOW_SAFETY_MARGIN`; `STREAM_IDLE_TIMEOUT_MS`;
   `setDeveloperDebugLogging`; `invalidateDebugEnabledCache`; `errorLog`; the
   `getFallbackModel` string-options overload; the production-unused
   `estimateMessagesTokensByCategory` + `TokenCategoryBreakdown`; the dead
   `tests/helpers/config-mock.ts`.
4. **Dedup helpers.** `buildHeaders()` in `client.ts` (was ×3), `clamp()` in
   `request-builder.ts` (11 inline pairs), `isCancellation(err, token)` in
   `src/shared/cancellation.ts` (was re-derived in three catch blocks), one
   private `emitValidatedToolCall` in the aggregator (was ×3).
5. **Config snapshot tightened.** The failover loop reads `NimConfig` once per
   hop and reuses it for the fallback decision; `prepareRequest` now requires
   `config`; discovery's dead `?? DEFAULT_MAX_OUTPUT_TOKENS` defense removed.
6. **Duplicate command fixed.** `nvidia-nim.saveLastTurnReport` no longer
   aliases `saveSessionLogs`; it saves the actual last turn report via a shared
   `saveDiagnosticsFile` flow.

Net effect: 36 suites, 691 tests green; lint, compile and `tsc --noEmit` clean.

---

## Open findings

### High

#### H1. `executeTurn` god-method (SRP / KISS) — [fixed]

[turn-executor.ts:148–843](../src/provider/turn-executor.ts) — ~700 lines
holding turn preparation, the attempt loop, stream error recovery, loop-breaker
injection, usage reporting, and turn-record bookkeeping. Symptoms:

- **~20 mutable locals** declared up front (`streamModel`,
  `streamMaxOutputTokens`, `baselineRequestBody`, `retryNudge`, four retry
  counters, `everSawReasoning`, `lastFinishReasonOverall`, …) — an implicit
  state machine.
- **Boolean soup**: six interlocking retry predicates at :513–538
  (`willRetryRepetitionLoop`, `willRetryHangingColon`, `willRetryTruncation`,
  …) collapse into a four-level nested ternary `currentRetryReason` at :577.
  Whether a retry happens and *why the user is told* are the same tangled
  decision.
- **The `attempt = -1` restart hack** (:463) fakes `while (true)` inside a
  bounded `for` after overflow compaction.
- **`maxAttempts` never binds** (:305): the formula
  `max(1, MAX_EMPTY+1, MAX_NET+1, 2, 1+MAX_INVALID+MAX_NET)` is so loose that
  real limits are enforced by the four scattered counters plus `fetchBudget`.
- A ~60-line inline debug block inside the loop; the overflow path resets eight
  variables in sequence (:445–467).

**Fix direction:** split the retry decision into a policy table
(`{ reason, eligible, nudge }`) evaluated by a small runner; make compaction
"new body, same runner" instead of a variable-reset chain; derive
`currentRetryReason` from the winning policy instead of a nested ternary. Keep
the VS Code-facing executor thin.

#### H2. Failover chain state smuggled on `options` (DIP / encapsulation) — [fixed]

`fallbackDepth`, `triedFallbackModelIds`, `fetchAttemptBudget` are read from the
VS Code `options` object (`fallback-orchestrator.ts:16–44`,
[chat-provider.ts:379–381](../src/provider/chat-provider.ts)) and written back
after each hop. `fetchAttemptBudget` travels **both** on `options` and as an
explicit `ModelTurnInput` field — two channels for one value. The chain lives in
the provider's `while (true)`; `fallback-orchestrator.ts` does not orchestrate
anything (it is helpers + UI notice).

**Fix direction:** an explicit chain-state object created per
`provideLanguageModelChatResponse` call and passed down; fold the one-caller
`readFetchAttemptBudget` into it.

#### H3. Config snapshot incomplete (DIP) — [fixed]

The turn hot path is snapshot-clean, but these surfaces still read live config:

- `src/tools/canonical-key.ts:15` and `src/tools/argument-repair.ts:42` —
  default parameters `ConfigManager.getToolsConfig()`; every duplicate-suppress
  and argument-repair call re-reads settings.
- `src/tools/vision.ts:71,121` — direct reads inside the tool.
- `src/shared/constants.ts:36` — `calculateSafetyMargin` (a "constants" module)
  reaches into `ConfigManager.getContextConfig()`; this is why `constants.ts`
  imports config and transitively the catalog.
- `src/shared/proposed-apis.ts:50` — `emitThinkingPart` reads
  `getReasoningConfig().showInChat` per streamed fragment (short-circuited only
  when `LanguageModelThinkingPart` is available).
- `src/shared/status-bar.ts:55` — per-update visibility read (benign, but part
  of the same pattern).

**Fix direction:** pass the per-turn `NimConfig` (or the specific slice) into
the tools layer and `calculateSafetyMargin`; read `showInChat` once per turn.

#### H4. Fat `ModelAdapter`; test-only capability contract (ISP / DRY) — [partially fixed]

After this pass the interface is down to 12 members, but `base.ts` still
declares the optional knobs twice (interface + `BaseModelAdapter` fields), and
`getCapabilityContract()`'s only consumer is
`tests/model-capability-matrix.test.ts:277` — production re-derives the same
routing boolean inline (`request-builder.ts:330`). The contract duplicates
production knowledge instead of *being* the source the pump consumes.

**Fix direction:** make the request builder consume `getCapabilityContract()`
(or delete the contract and let the matrix call the same production helper).
Split `ReasoningPolicy` / `SamplingProfile` out of the adapter only if another
consumer appears — otherwise leave the class as is (KISS).

### Medium

#### M1. `client.ts` internals: SSE loop duplicated (DRY) — [fixed]

The SSE line-parse block exists twice — mid-stream
([client.ts:585–613](../src/api/client.ts)) and final flush (:615–641) —
including the partial-buffer guard. The first-token/idle timeout error message
is built twice. The abort check-then-subscribe race is handled by two parallel
implementations (`waitForRetry` and `readWithTimeout`) with cross-referencing
comments. **Fix:** one `parseSseBuffer()` helper and one timeout-error factory;
consider extracting the shared "subscribe after check" into one utility.

#### M2. Token estimation: twin image heuristics (DRY) — [open, cosmetic]

`token-estimate.ts` is much leaner after the dead VS Code category walk was
deleted, but the `Math.max(4, bytes / 750)` image heuristic exists twice
(`estimatePartTokens` :62 and `estimateImageUrlTokens` :~150), and the two
walks (VS Code part-based vs NIM message-based) remain parallel shapes. The
walks are semantically different inputs — acceptable — but the byte heuristic
and the category names should be single-sourced.

#### M3. `reasoning-router` re-implements `think-filter` algorithms (DRY / OCP) — [open, streaming-risk]

`findOrphanedCloseTag` / `findPartialCloseTagEnd`
([reasoning-router.ts:14–38](../src/messages/reasoning-router.ts)) are
case-sensitive near-twins of `think-filter.ts`'s case-insensitive
`findEarliestCaseInsensitiveIndex` / `findTrailingCaseInsensitivePrefixStartAny`
(:28–60), and the "split on close tag into before/after" block repeats four
times inside the router (:111–236). A change to tag scanning must be made in
two places. **Fix:** one shared tag-scanning module with a case-sensitivity
flag; one `splitOnCloseTag` helper.

#### M4. `discovery` vs `refresh`: duplicated fetch→normalize→cache-write (DRY) — [fixed]

[refresh.ts:51–73](../src/models/refresh.ts) duplicates
`discovery.ts`'s block, including the statically-always-true
`typeof fetchModelsOrThrow === "function" ? … : fetchModels` guard that exists
only so jest can mock `fetchModels` (`refresh.ts:52`, `discovery.ts:156`).
**Fix:** one fetch-and-cache function; mock at the module boundary instead.

#### M5. Tool-call pairing fixpoint implemented twice (DRY) — [fixed]

`splitMessagesForSummarization` (`summarizer.ts:201–220`) is a near-twin of
`truncateMessagesForContext`'s pairing loop (`converter.ts:278–309`) — the same
"tool result must keep its owner" invariant. **Fix:** one shared pairing
helper in `messages/`.

#### M6. `prepareRequest` ~300 lines, duplicated conversion preamble (SRP / DRY) — [partially fixed]

[request-builder.ts:165–429](../src/provider/request-builder.ts) does
estimation, two compaction paths, max-tokens math, sampling assembly, and
reasoning-mode selection. The "convertMessages + applyMessagesWorkaround +
extraSystemMessages prepend" preamble is duplicated with
`overflow-compactor.ts:52–68`. `PreparedRequest.safetyMargin` and
`.extraSystemMessages` are returned but never consumed by callers.
**Fix:** extract `convertWithProfile()` shared by builder and compactor; delete
the two unused `PreparedRequest` fields; optionally split budgeting from
assembly.

#### M7. `repetition-guard` mixes streaming and history-loop detection (SRP) — [fixed]

The class holds streaming line-repetition state, while static
`detectHistoryLoop` / `detectToolCallHistoryLoop` (:208–318) belong with
`loop-breaker.ts`; the consecutive-run counting tail is duplicated
(:236–247 vs :305–317); the pure detection class imports `vscode`
(:1, :195 — `LanguageModelChatMessageRole`). **Fix:** move history-loop
detection next to the loop breaker; inject the role constant.

#### M8. UI leaks inside non-UI modules (layering) — [fixed]

`overflow-compactor.ts:117` pops `vscode.window.showInformationMessage` from
inside the compaction module; `fallback-orchestrator.ts:129` does the same for
hop notices. Both make the modules untestable without a vscode mock. **Fix:**
return a "should notify" result and let the provider/extension surface it.

#### M9. Layering inversions remain — [partially fixed]

- `src/shared/config.ts:2` imports `../models/catalog` (shared → models).
- `src/shared/constants.ts:2` imports config (a leaf depending on live config —
  same root as H3).
- `src/models/refresh.ts:10` imports `NimChatModelProvider` (models → provider)
  for a UI refresh callback.

**Fix direction:** invert each with a callback or parameter; none is urgent
alone, but together they keep `shared` from being a true bottom layer.

#### M10. `sync-manifest.mjs` regex-parses catalog source (fragility) — [open, needs build-order change]

`scripts/sync-manifest.mjs:12–22` extracts `MODEL_LIST` by pattern-matching the
TypeScript source text; a formatting change silently breaks the sync. The test
asserting package.json ↔ catalog catches drift, but the tool itself is fragile.
**Fix:** emit the model list to JSON from `tsc` (a tiny script importing the
compiled `catalog.js`) instead of scraping source.

#### M11. `parser.ts` barrel over-exports (YAGNI) — [fixed]

Most of the ~17 re-exports (`normalizeScalar`, `normalizeProperties`,
`valuesEqual`, `sortObjectKeys`, `parseDeepSeekTextEmbeddedToolCallContent`,
`findTrailingTokenPrefixStart(Any)`, …) have no external caller — they are
internal helpers of the split modules. The barrel is the only import surface
provider code uses, so every internal helper is effectively public.
**Fix:** narrow the barrel to the symbols provider/tests actually import and
make the rest module-private.

### Low / YAGNI leftovers

- **Dormant `pickerStatus` machinery** (`catalog.ts:25,128–130`,
  `discovery.ts:223–230`): defined, synced, tested — no entry uses it. Keep
  only if a deprecation is genuinely planned; otherwise remove.
- **`assignReasoningEffort` delegation written three times**
  (`nemotron.ts:19–21`, `kimi.ts:36–38`, `base.ts:131–133`). Awaiting a
  multiple-inheritance-free way to compose `NemotronFamilyAdapter` with
  `ReasoningEffortAdapter`; data-driven modes would remove the duplication.
- **Legacy "configured API key" fallback path** (`chat-provider.ts:67–96`,
  `:280`, `:349`) kept for migration back-compat; delete once
  `MIGRATION_DONE_KEY` has fully shipped in the population.
- **Mirror-style catalog rows in tests**: `tests/model-catalog.test.ts:17–120`
  hard-codes per-model display names and limits instead of asserting
  invariants; `tests/config.test.ts:29–30` hard-codes the two fallback ids
  instead of importing `FALLBACK_MODEL_ID` / `FALLBACK_VISION_MODEL_ID`.
- **Test-only exports** kept deliberately: `resetSessionLogsForTests`,
  `resetTurnReportsForTests`, `getNimConfig` (production now snapshots through
  the same method). Fine as-is.
- **Oversized internals** worth a look during any future touch of their files:
  `repairToolArguments` (`argument-repair.ts:37–303`, ~266 lines of alias
  merging + per-tool repair), `scanToolRegion`
  (`xml-tool-scanner.ts:355–474`), `readXmlTag` (:120–189),
  `provideLanguageModelChatResponse` (`chat-provider.ts:362–517`).

---

## Principles → hottest remaining evidence

| Principle | Remaining evidence |
|---|---|
| **SRP** | `executeTurn` (H1); `prepareRequest` (M6); `repetition-guard` (M7) |
| **OCP** | reasoning-router/think-filter tag scanning (M3); global `reasoning.mode` enum vs per-model vocabularies |
| **LSP** | global `nvidia-nim.reasoning.mode` silently remaps `low` / `xhigh` / `adaptive` to a model's first supported mode (request-builder :312–322) |
| **ISP** | adapter knobs declared twice (H4); `PreparedRequest` returns unused fields (M6) |
| **DIP** | failover state on `options` (H2); remaining hidden config reads (H3); layering inversions (M9) |
| **DRY** | SSE loop (M1); image heuristic (M2); pairing fixpoint (M5); conversion preamble (M6) |
| **KISS** | `attempt = -1` restart + never-binding `maxAttempts` (H1); barrel over-exposure (M11) |
| **YAGNI** | dormant `pickerStatus`; legacy API-key path; mirror rows in tests |

One open item from the previous review was **deliberately kept**: the global
`nvidia-nim.reasoning.mode` setting. The per-model picker in discovery is the
right control; until the workspace default is reduced to `{ off, on }` or
dropped, the silent remap in the request builder stays a trap for new adapters.

---

## What was fixed in the follow-up pass (same day)

All High and Medium items except the three marked **[open]** above:

- **H1:** retry classification extracted into a pure `evaluateAttemptRetry`
  (single winning reason, branch order preserved); the attempt loop is a
  labeled `while` with per-restart budgets; `attempt = -1` and the reset chain
  are gone — overflow compaction re-enters the same loop with a fresh attempt
  index and counters.
- **H2:** failover chain state is a local `chainState` object;
  `FallbackChainOptions` and the `read*` helpers deleted.
- **H3:** `calculateSafetyMargin` moved to `shared/config.ts` (constants no
  longer import config) with `safetyMarginPercent` threaded explicitly through
  the turn path; `ToolsConfig` threaded into the aggregator; `showInChat`
  snapshotted per turn.
- **H4 (partial):** `isReasoningIsolationExpected` in `base.ts` is the single
  source used by both the request builder and the capability matrix. The
  adapter interface shape was deliberately left as is (only one consumer
  exists; splitting would be speculative).
- **M1:** `parseSseLines` / `assertSsePartialBufferWithinLimit` /
  `streamTimeoutError` in `client.ts`.
- **M4:** `fetchCuratedModels` in `models/fetch-curated.ts` (the duplicated
  fetch→report→normalize→cache block now exists once).
- **M5:** `tool-call-pairing.ts` shared by converter and summarizer.
- **M6 (partial):** `convertMessagesWithProfile` shared by builder and
  compactor; unused `PreparedRequest` fields deleted. The ~300-line
  `prepareRequest` was otherwise left alone — its budgeting steps are
  sequential by nature and splitting them further would add indirection
  without a second consumer.
- **M7:** history-loop detectors are in `loop-breaker.ts`; `RepetitionGuard`
  is streaming-only and vscode-free; the counting tail is one helper.
- **M8:** overflow notice moved to the turn executor; `reportFallbackHop`
  moved to chat-provider. Both helper modules are UI-free.
- **M9 (partial):** the `constants → config` inversion dissolved when
  `calculateSafetyMargin` moved. `shared/config → models/catalog` and
  `models/refresh → provider` remain (both are single, deliberate links).
- **M11:** parser barrel pruned to externally consumed symbols.
- **Low:** dormant `pickerStatus` machinery removed; `KimiAdapter` extends
  `ReasoningEffortAdapter` (third `assignReasoningEffort` delegation gone);
  `config.test.ts` asserts fallback defaults via catalog constants.

Verification for the pass: lint, compile, `tsc --noEmit`, and 691 tests green.

---

## Still open, deliberately

- **M2 (image heuristic ×2 in `token-estimate.ts`)** — cosmetic; the two walks
  take different input shapes, and forcing one helper would couple the VS Code
  and NIM estimators for ~4 lines of shared math.
- **M3 (reasoning-router vs think-filter algorithms)** — real duplication, but
  both modules sit on the streaming hot path and their case-sensitivity
  differences are behavioral. Worth doing only with streaming fixture tests
  around it.
- **M10 (sync-manifest regex scraping)** — the script runs on `precompile`,
  before `tsc`, so compiled `catalog.js` does not exist yet; moving sync after
  compile changes the build pipeline. Needs its own small, deliberate change.
- **Legacy `fetchModels` wrapper + always-true `typeof` guard** — deleting it
  means migrating seven test suites that mock `fetchModels`. One copy of the
  guard now lives in `fetch-curated.ts`.
- **Legacy configured-API-key fallback path** — retained until the
  `MIGRATION_DONE_KEY` migration has fully shipped in the population.
- **Oversized internals** (`repairToolArguments`, `scanToolRegion`,
  `readXmlTag`) — restructuring them pays off only alongside the tests that
  pin their behavior; left for a targeted pass.
- **Global `nvidia-nim.reasoning.mode`** — product decision, unchanged.

---

## Out of scope / load-bearing — do not "simplify"

- The multi-protocol embedded-tool parser (DeepSeek DSML, XML, native
  `tool_calls`) and per-vendor reasoning encodings are the product.
- The shared fetch-attempt budget across retries and hops is a correctness
  feature.
- `xml-tool-scanner.ts` is long because the XML dialect is long.
- The capability matrix as a behavioral pin — keep it; it already stopped
  copying catalog metadata.
