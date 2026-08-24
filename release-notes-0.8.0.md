# v0.8.0 — No more loops, auto-continue, and smarter sampling

This release fixes the infinite looping reported in #7 and polishes reliability across the extension. No config change is required — just update.

## Fixed: infinite `Let me fix / Let me run the test` loops

Both Nemotron Ultra (exact `Let me fix the formatting issue:` ×13) and Lightning (paraphrased `Let me run / Let me execute the test …`) could loop forever.

* **Root cause fixed:** Nemotron now keeps your requested `temp 1 / topP 0.95` but adds mild `frequency_penalty 0.15 / presence_penalty 0.08` by default so it doesn't get stuck in the same sentence. Low-temp models (DeepSeek `0`, GLM `0.1`) keep their `0.2 / 0.1` damping. The prompt now forbids starting with `Let me fix/run/check` when a tool is needed — it goes straight to the tool call.
* **Safety net kept:** the repetition guard is still there (Unicode-aware, ignores code inside fences) but is now a fallback. If it trips, the turn automatically continues with a `hey you got stuck, continue working` nudge instead of ending with `Stopped early`. Turn `.vsix` off with `nvidia-nim.generation.autoContinueOnLoop: false` to get the old notice back. Also handles hangs that end with `:` and no action (per your report).

## New: sampling controls you can tune

* `nvidia-nim.generation.frequencyPenalty` (-2..2), `presencePenalty` (-2..2), `repetitionPenalty` (0.5..2) — all `null` by default. Set them if a model still feels repetitive; otherwise the sensible defaults above do the job.

## Reliability & security polish

* API keys and `Bearer` tokens are now redacted in logs
* `Manage API Key` no longer pre-fills the secret into the input box
* Model IDs in settings are validated against the curated list (unknown IDs fall back with a warning)
* Timeouts now distinguish `timeout` from user cancellation, and streaming cancellation is idempotent — no more hung connections
* Surrogate-pair safe truncation and status-bar markdown escaping

## Settings changed

* Added `nvidia-nim.generation.autoContinueOnLoop` (`boolean`, default `true`)
* Added `nvidia-nim.generation.frequencyPenalty` / `presencePenalty` / `repetitionPenalty` (`number|null`)

All 33 settings are documented in `docs/README.md`.

## Install / Update

From the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent), via the Extensions view, or download `nvidia-nim-agent-0.8.0.vsix` and use **Install from VSIX...**.
