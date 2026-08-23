# v0.7.0

Kimi K3, fallback priority list, loop guard and real token usage in the chat widget.

## New model: Kimi K3

`moonshotai/kimi-k3` — 1M context, tool calling, vision, reasoning effort `none`/`low`/`high`/`max` from the model picker dropdown.

## Fallback priority list

New setting `nvidia-nim.fallback.priorityList`, configurable in VS Code Settings. It's an ordered list of models tried one by one on rate limit, model outage, empty response or timeout — before the regular `fallback.model` / `fallback.visionModel` are used (e.g. `moonshotai/kimi-k3`, then `minimaxai/minimax-m3`).

Models that are unavailable or already tried are skipped. If the whole list fails, the error now shows what was tried (`Tried chain: kimi-k3 -> minimax-m3`) and the last underlying error instead of just "rate limited".

## Repetition loop guard

Models sometimes get stuck repeating the same line ("Let me fix the formatting issue:" over and over). The extension now counts repeated lines in the stream and cuts the output once the same line appears `nvidia-nim.generation.maxRepeatedLines` times (default 4). A short notice is added to the chat and the turn ends normally. `0` disables the guard.

## Token usage in Copilot Chat

The context window widget next to the chat input used to always show `0 / 1M tokens (0%)` for NVIDIA NIM models. The extension now reports real `prompt_tokens` / `completion_tokens` / `total_tokens` from the NIM stream, including after retries and failovers.

## Removed models

- `moonshotai/kimi-k2.6` — the NIM endpoint returns 404, replaced by Kimi K3.
- `z-ai/glm-5.2` — dropped from the NVIDIA NIM catalog.

## Install / Update

From the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent), via the Extensions view, or download `nvidia-nim-agent-0.7.0.vsix` and use **Install from VSIX...**.
