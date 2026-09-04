# Change Log

What changed for Copilot Chat users. Contributor notes live in `CHANGELOG.dev.md`.

## [Unreleased]

## [0.10.1] - 2026-09-05

### Fixed

- **Rate-limit and overload errors now keep NVIDIA's response text.** After the last retry, Copilot Chat can show the service's own message instead of a generic HTTP status.
- **Long chats with images summarize the actual text.** Compaction no longer feeds the summarizer a JSON blob of each text part.
- **An empty model list is no longer treated as a finished cache.** If a refresh comes back with no curated models, the next request fetches again instead of leaving the picker blank.
- **Two tool calls in one stream are not dropped when the API omits `index`.** Each call gets its own slot instead of colliding on slot 0.
- **Unsupported reasoning modes log a warning.** Reasoning still turns off for that request, but the Output channel records which mode was rejected and what the model supports.
- **Default model sampling parameters match NVIDIA specifications.** Models in the catalog now default to temperature 1.0 and top_p 0.95, matching build.nvidia.com recommendations and preventing repetition loops caused by greedy sampling.

### Changed

- **Turn retries are classified once, then applied.** Overflow compaction reuses the same recovery budget as a fresh request and no longer pops a toast from inside the retry engine; the notice still appears from the chat layer.

## [0.10.0] - 2026-09-04

### Fixed

- **File-read tool calls no longer fail for missing line numbers.** If the model names a file but omits `startLine` / `endLine`, the extension fills a default range and sends the call to Copilot. Calls that are still invalid (for example missing `filePath`) are retried with the model, not printed as a rejection in chat.
- **Recoverable stream failures stay with the model.** A repetition loop, a truncated reply, or a safety filter after some text (with no tool call) now nudges the model instead of printing a diagnostic notice in chat. A bad tool call that cannot be repaired is retried, then handed to the backup model as an invalid-tool failover, instead of ending the turn silently.
- **An unsupported reasoning mode no longer silently upgrades itself.** If the requested mode is not in the model's supported list, reasoning is turned off for that request instead of switching to the first available effort level.
- **NVIDIA NIM: Save Last Turn Report now saves the last turn report.** Both save commands previously produced the same session-log file. The turn-report command now writes its own report file, and each command explains when there is nothing to save yet.
- **Context overflow now retries with a full remaining budget.** After history is compacted, empty-stream and invalid-tool recovery still run, and the same-turn loop breaker still applies even if auto-continue is off.
- **A failed overflow compaction still tells you to start a new chat.** The error is no longer a raw server 400 with no recovery hint.

### Changed

- **Settings you change now take effect cleanly on your next message.** The extension takes one snapshot of your settings per request, so editing a setting while a response is streaming no longer changes how that in-flight reply is assembled or retried.
- **Recovery after history compaction is more consistent.** The follow-up attempt after context is compacted now uses the same retry policy as a fresh request, with one predictable recovery budget shared by retries, compaction, and failover hops.
- **Tool-enabled MiniMax (and similar models) now get the same visible-reply hygiene as the rest of the catalog.** They are instructed not to emit XML section wrappers or Copilot content-ref links.
- **Context overflow retry now follows the same recovery path as a normal turn.** After the history is compacted, the reply can still recover from an empty stream or a bad tool call, and the Copilot token widget is updated.
- **Streamlined turn execution and history compaction.** Improved reliability during long conversations: history compaction before a turn and after a context overflow share the exact same budgeting formula and compaction engine.
- **Enhanced tool calling and response handling.** Tool argument repair and validation have been restructured into dedicated components for cleaner error handling and duplicate prevention across multi-turn sessions.

## [0.9.7] - 2026-09-02

### Fixed

- **A skipped fake tool call no longer ends the turn.** If the model keeps calling something that is not a Copilot tool, the extension retries more than once and then failsover instead of stopping after a preamble.

## [0.9.6] - 2026-09-01

### Fixed

- **Temporary NVIDIA overload no longer ends the chat.** If the service is briefly overloaded, the extension retries the same model and, if needed, continues on the backup model. This still works when the model had already printed some text and then retried a bad tool call. The reply should continue instead of stopping with an error.

## [0.9.5] - 2026-08-30

### Changed

- **Nemotron 3.5 Lightning is back in the picker.** It no longer shows as Unavailable. If the old label is still there, run **NVIDIA NIM: Refresh Models** from the Command Palette.

### Fixed

- **Repeating paragraphs without line breaks are stopped.** If a model starts cycling the same paragraph, the stream is cut off. By default the extension then nudges the model to keep working instead of spinning until Copilot asks you to continue.

## [0.9.4] - 2026-08-29

### Added

- **Save Session Logs.** Command Palette **NVIDIA NIM: Save Session Logs** writes a JSON file of recent turns and technical events to Downloads. Debug logging does not need to be on first. **Save Last Turn Report** still works as an alias.
- **Optional extra debug.** Settings `nvidia-nim.developer.logStreamChunks` and `nvidia-nim.developer.logUserMessages` (off by default) can include stream chunks and outgoing message bodies. Ordinary debug output stays technical-only.

### Changed

- Stream chunks and outgoing request bodies no longer appear just because debug logging is on. Turn those two settings on if you need them.

## [0.9.3] - 2026-08-29

### Added

- **Last turn report.** Command Palette **NVIDIA NIM: Save Last Turn Report** writes a short JSON report of the latest chat hops to Downloads, so a failed turn can be attached to an issue without enabling debug logging first.

### Changed

- User docs are split into topic guides (getting started, models, failover, tools, context, configuration, troubleshooting).
- The install package no longer ships test-coverage reports.
- If the usual text backup model is missing, failover tries other healthy models instead of giving up.
- Network failures can fail over, and the in-chat notice says whether it was a network, server, overflow, or rate-limit problem.
- Thinking-only replies can fail over to another model instead of mixing two models in one answer.
- Image analysis uses the configured vision backup model.
- Unknown Copilot reasoning modes map to a supported mode instead of silently turning reasoning off.

### Fixed

- Replies cut off at the token limit can continue once, or show a short notice.
- A trailing colon no longer misses the "keep going" retry when it was split across stream chunks.
- Stream error objects from NVIDIA are no longer ignored.
- Oversized chats compact once before switching models.
- Oversized images are rejected with a clear error instead of being dropped.
- A missing API key fails the turn instead of looking like an empty assistant reply.
- Clearing the API key also refreshes the model list.

## [0.9.2] - 2026-08-28

### Removed

- **Step 3.7 Flash is gone.** NVIDIA retired that endpoint. Pick another model if you still had it selected.

### Changed

- Default text backup and summarization model is **Nemotron 3 Super 120B**. Default vision backup is **Muse Glimmer**. MiniMax M3 stays in the picker.
- **Nemotron 3.5 Lightning** showed as Unavailable in the picker while still selectable (restored in 0.9.5).
- README and docs include Artificial Analysis Intelligence Index scores for the curated models.

### Fixed

- Retired models (HTTP 410) fail over instead of killing the turn.
- Tool-argument repair no longer invents file paths from nearby chat text.
- Huge stream lines cannot hang the connection.
- API key, settings, and log handling are safer (keys stay out of logs, untrusted workspaces skip auto-migration).
- Marketplace version badge is no longer stuck on an old number.

### Security

- Pinned a transitive dependency (`minimist`) to a known-good version.

## [0.9.1] - 2026-08-27

### Added

- **DeepSeek V4 Pro 0813** in the model picker: about 1M context, large output, tool calling, and High / Max reasoning.

## [0.9.0] - 2026-08-26

### Added

- **Nemotron 3 Super 120B** in the model picker: about 1M context, tool calling, and None / Low / High reasoning. A solid everyday agent model.

### Fixed

- File-read tools no longer borrow line ranges from a different file in the editor. Reads start at line 1 when the model omits a range. Edit tools still use the current selection only on the matching file.

## [0.8.1] - 2026-08-25

### Fixed

- **Kimi K3 no longer errors** if you set presence or frequency penalty in settings. Those knobs are ignored for Kimi; repetition penalty still applies.
- Nemotron no longer injects hidden default penalties. Only the values you set in `nvidia-nim.generation.*` are sent.

### Changed

- **Inkling** is removed from the picker after NVIDIA retired it. A later successor can still be added without rewriting the adapter.

## [0.8.0] - 2026-08-24

### Added

- **Repetition guard.** If a model repeats the same line (default 4 times; `nvidia-nim.generation.maxRepeatedLines`, `0` disables), the stream stops instead of looping "Let me fix…". Code fences are ignored so repeated code is not treated as a loop.
- **Cross-turn loop breaker.** The same stuck preamble or tool call across several assistant turns gets a nudge to move on.
- **Sampling penalties.** Settings `nvidia-nim.generation.frequencyPenalty`, `presencePenalty`, and `repetitionPenalty`.
- **Auto-continue on loop.** `nvidia-nim.generation.autoContinueOnLoop` (default on) retries once with a "you got stuck" nudge instead of ending the turn. Turn it off to see the stop notice.

### Changed

- Nemotron sampling stays at temperature 1 / top_p 0.95. Tool replies skip the "let me…" preamble when a tool is needed.
- Reasoning from earlier turns is passed back in history where the model supports it.
- File-read tools fill missing `startLine` / `endLine` instead of failing the call.
- Idle stream timeout honors `nvidia-nim.network.streamIdleTimeout` (15–600 seconds).

### Fixed

- Logs redact API keys and Bearer tokens.
- Manage API Key no longer pastes the stored key into the input box.
- Startup no longer leaves a silent failed promise if key init races.
- Hung non-stream requests time out instead of hanging forever.
- Unknown model ids in fallback settings are skipped with a warning.
- Status bar tooltips cannot inject markdown from a model name.

## [0.7.0] - 2026-08-23

### Added

- **Kimi K3** in the picker: about 1M context, vision, tools, and None / Low / High / Max reasoning.
- **Fallback priority list.** Setting `nvidia-nim.fallback.priorityList` tries models in order before the usual text or vision backup. If every candidate fails, the error lists the chain that was tried.
- **Line-repeat stop.** `nvidia-nim.generation.maxRepeatedLines` (default 4) stops a stream that keeps printing the same line.

### Removed

- **Kimi K2.6** and **GLM 5.2** (gone from NVIDIA NIM).
- Experimental Copilot edit-tools hint UI. Token usage reporting for the context-window widget is unchanged.

### Changed

- After each reply, Copilot's context-window widget can show real token usage instead of a permanent `0 / 1M`.

## [0.6.1] - 2026-08-19

### Added

- **Vision-aware failover.** If the current model fails on a request that includes images, the backup is a vision model (`nvidia-nim.fallback.visionModel`, then MiniMax M3) instead of a text-only model.
- If you are already on the backup model and it fails, the next healthy vision model is used.

### Changed

- Kimi K2.6 showed as Deprecated while NVIDIA was returning 404.

## [0.6.0] - 2026-08-18

### Added

- Full settings trees: fallback, network, reasoning, generation, tools, context, UI, and developer.
- Timeouts you can change: stream idle timeout, HTTP retries, first-token timeout.
- A dedicated summarization model (`nvidia-nim.context.summarizationModel`) and auto-compact on overflow.
- Failover banners in chat, plus toggles for rate limit, missing model, empty stream, and timeout.
- Sampling and tool knobs: temperature, top_p, max output tokens, auto-repair arguments, retry invalid tool calls, suppress duplicate reads.
- Status bar visibility and debug / timing logs.
- Cleaner Marketplace listing: display name **NVIDIA NIM Agent**.

### Removed

- **NVIDIA NIM: Toggle Show Reasoning.** Reasoning is shown through VS Code's native thinking UI and the model picker's reasoning dropdown.

## [0.5.5] - 2026-08-18

### Added

- More reliable tool calling when the model writes tools as XML or mixed text: arguments are repaired, aliases like `path` → `filePath` are filled, and search/terminal tools are less likely to get stuck.
- Duplicate terminal or edit commands can run again (for example compile after a failed build). Duplicate file reads are still skipped.
- Extra thinking tag shapes are recognized.

### Fixed

- File edits that contain `</tool_call>` in the source no longer get truncated or dumped into chat.
- XML inside markdown code fences stays as code.
- HTTP 404 on a model fails over instead of ending the turn.
- Duplicate error stacks are no longer shown in the VS Code UI.

## [0.5.4] - 2026-08-17

### Added

- **DeepSeek V4 Flash 0731** (replaces the withdrawn Flash and Pro endpoints): about 1M context, tools, None / High / Max reasoning.
- **Nemotron 3.5 Lightning 30B**: compact fast text model, 1M context, tools, None / Medium / High / XHigh reasoning.
- HTTP 529 (service overloaded) fails over like a rate limit, with an "Overloaded" notice.

### Changed

- Default backup and summarization model became Lightning (later Super 120B in 0.9.2).
- Isolated reasoning modes no longer hide a normal reply as thinking, and the answer streams as it arrives after reasoning.

### Removed

- Original DeepSeek V4 Flash and DeepSeek V4 Pro IDs (NVIDIA withdrew them).

## [0.5.3] - 2026-08-16

### Changed

- Internal robustness: missing model adapters no longer crash the chat provider. TypeScript and tests were tightened.

## [0.5.2] - 2026-08-14

### Added

- A shared retry budget so one overloaded model is not hammered with stacked retries.
- After a too-long prompt is compacted, tool calls and thinking from the retry are kept.
- Image analysis rejects remote URLs and images over 20 MB before calling NVIDIA.
- Status bar token breakdown stays clickable.

### Changed

- Ordinary "invalid max_tokens" errors are no longer treated as "prompt too long".
- After a dropped connection, the retry nudge is a normal user turn so more models accept it.

## [0.5.1] - 2026-08-13

### Added

- **Muse Glimmer 30B**: 131k context, vision, tools, and None / Low / Medium / High / XHigh reasoning.

### Removed

- **Laguna XS 2.1** left the picker.

## [0.5.0] - 2026-07-29

### Added

- Empty NVIDIA replies are retried, then fail with a real error instead of Copilot's "Sorry, no response was returned".

### Changed

- A turn that only thinks and never answers is treated as a failure, not a successful blank reply.

## [0.4.10] - 2026-07-27

### Added

- If NVIDIA reports a smaller context limit than the catalog, later requests use that limit so the same overflow is not repeated.

### Changed

- Catalog context windows and output limits match what NVIDIA actually serves.
- Streaming, tool repair, cancellation, and token accounting are more accurate.
- Published packages are smaller (only the runtime `jsonrepair` dependency).

### Fixed

- Overflow errors report the real token counts.
- A too-long prompt is compacted at most once per request.
- API keys stay out of model metadata and logs.
- The image-analysis tool is registered with VS Code so it is available in Agent mode.

## [0.4.9] - 2026-07-23

### Fixed

- Marketplace VSIX dropped from about 12 MB to under 600 KB by excluding a local tooling folder.

## [0.4.8] - 2026-07-23

### Added

- **Laguna XS 2.1** (later removed in 0.5.1): 262k context, None / On reasoning.

### Fixed

- Laguna replies that were only text no longer hide inside the thinking block.
- NVIDIA 404 names the missing model instead of looking like a Copilot outage.

## [0.4.7] - 2026-07-17

### Added

- **Inkling** in the picker (later retired): 1M context, vision, tools.

## [0.4.6] - 2026-07-03

### Fixed

- GLM 5.2 no longer returns an empty error when reasoning is turned on.

## [0.4.5] - 2026-07-03

### Changed

- Internal split of request building, tool-call streaming, and model discovery. No user-facing behavior change intended.

## [0.4.4] - 2026-07-03

### Added

- **GLM 5.2** (later removed from NVIDIA): 1M context. Opening text is no longer trapped in the thinking block.

### Removed

- **GLM 5.1**.

## [0.4.3] - 2026-06-27

### Fixed

- Reasoning no longer leaks into the visible answer mid-stream (DeepSeek, GLM, MiniMax, Nemotron), including when code fences sit inside thinking.
- Status bar tooltip marks real API token counts as actual.

## [0.4.2] - 2026-06-27

### Fixed

- MiniMax M3 and Kimi K2.6 stream token by token instead of dumping the whole reply at the end.
- Reasoning and answer tokens in the same chunk no longer split the reply in half.
- MiniMax and Kimi honor the reasoning mode from the picker.
- Literal `<think>` in source code is not stripped from the answer.
- MiniMax `<mm:think>` blocks show in the thinking UI.

### Added

- MiniMax **Adaptive** reasoning: the model decides whether to think.

## [0.4.0] - 2026-06-26

### Added

- Status bar shows context use (for example `25.5k/262.1k`). Hover for a per-category breakdown. Color warns above 80% and 95%.

### Fixed

- Token counts for tool calls, tool results, and images were far too low, which hid Copilot's context widget on agent chats.

### Changed

- Clicking the status bar after a reply no longer refreshes models. Use the Command Palette for refresh.

## [0.3.0] - 2026-06-25

### Added

- Status bar shows token usage after each reply.
- HTTP 429 automatically retries on a lighter backup model.
- A dropped stream with no text yet is retried.
- Oversized chats are summarized instead of failing hard.

## [0.2.8] - 2026-06-25

### Added

- Kimi-style `think` tags render as collapsible thinking, not stripped text.

## [0.2.7] - 2026-06-25

### Added

- Reasoning effort in the Copilot model dropdown (None / On / High / Max, depending on the model).
- Native collapsible thinking in VS Code when the model streams reasoning.

### Fixed

- GLM and MiniMax no longer 400 on reasoning. DeepSeek High / Max actually turn thinking on.

## [0.2.6] - 2026-06-25

### Changed

- Version bump so a local VSIX install is not stuck on a cached older build.

## [0.2.5] - 2026-06-25

### Added

- GLM 5.1 reasoning.

### Removed

- Broad older families (Mistral, Qwen, Phi, Yi, Gemma, Llama-4 Scout, older Nemotron). The picker focused on DeepSeek, Nemotron, Kimi, MiniMax, StepFun, and GLM.

## [0.2.4] - 2026-06-25

### Added

- Infrastructure for custom dropdowns in the Copilot model picker (used for reasoning modes).

## [0.2.3] - 2026-06-25

### Fixed

- Temperature and reasoning options no longer overwrite each other in the request.

## [0.2.2] - 2026-06-25

### Added

- DeepSeek, Kimi, MiniMax, and Nemotron honor the selected reasoning mode.

## [0.2.1] - 2026-06-25

### Added

- Workspace setting `nvidia-nim.reasoningMode` as a default when the picker does not send a mode.

## [0.2.0] - 2026-06-25

### Added

- First reasoning support, including `nvidia-nim.showReasoning` to show hidden thinking in chat.

## [0.1.23] - 2026-04-29

### Changed

- Slightly faster chat path on plain text turns (tool parsing starts only when tools appear).

## [0.1.22] - 2026-04-26

### Added

- Extra model families in the picker (later trimmed in 0.2.5).

### Changed

- Better token estimates for CJK text. Image analysis retries on network errors.

## [0.1.21] - 2026-04-26

### Fixed

- Raw tool-control markers no longer leak into chat. Bad embedded tool calls retry once instead of printing junk.

## [0.1.20] - 2026-04-26

### Fixed

- Marketplace package no longer includes local venv, tests, docs, or TypeScript sources.

## [0.1.19] - 2026-04-26

### Fixed

- Empty `read_file` tool calls retry once instead of failing the turn immediately.

## [0.1.18] – [0.1.10] - 2026-04-25 to 2026-04-26

### Fixed

- Duplicate NVIDIA rows in Manage Models and the model picker.
- Legacy `nvidia-nim/<model>` ids and named provider groups both resolve.
- API keys from **NVIDIA NIM: Manage NVIDIA NIM API Key** are used when the Copilot group has no key yet.

## [0.1.9] - 2026-04-25

### Fixed

- Models stay selectable in Agent mode even when NVIDIA omits tool-calling metadata.

## [0.1.8] - 2026-04-25

### Fixed

- Legacy API keys migrate into VS Code's language-model provider group so Copilot's picker actually lists NVIDIA models.

## [0.1.7] - 2026-04-25

### Added

- API key field in VS Code's model provider settings.

## [0.1.6] - 2026-04-25

### Fixed

- Model picker can fetch models on demand if the background refresh has not finished.

## [0.1.5] - 2026-04-25

### Fixed

- Empty or corrupt model caches no longer leave stale picker entries.

## [0.1.4] - 2026-04-25

### Changed

- Picker shows only models discovered from NVIDIA NIM, not a copied third-party catalog.

## [0.1.3] - 2026-04-25

### Added

- First NVIDIA NIM Copilot Chat provider: streaming chat, tool calling, vision gating, SecretStorage API key, and commands to manage the key, refresh models, and open the debug log.
