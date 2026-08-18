# v0.6.0

## Settings, failover you can see, and a real Marketplace listing

This release turns the hidden knobs into Settings UI, makes failover a one-turn detour instead of a silent swap, and ships the listing people actually land on: **NVIDIA NIM Agent**, an Install button, and a demo of native thinking in Copilot Chat.

## Settings

Everything lives under **NVIDIA NIM** in Settings. Defaults stay the same if you never open the page.

- **Failover:** backup model, and which failures trip it (rate limit / 529, model unavailable, empty stream, first-token timeout).
- **Network:** HTTP retries, stream idle timeout, first-token timeout.
- **Generation:** temperature, top-p, max output tokens, default reasoning mode.
- **Tools:** auto-repair arguments, retry invalid calls, suppress duplicate reads.
- **Context:** dedicated summarization model, overflow auto-compact, safety margin.
- **UI / developer:** status bar on/off, debug log, millisecond TTFT / tok/s breakdowns.

Legacy `nvidia-nim.reasoningMode` and `nvidia-nim.showReasoning` still map through. The **Toggle Reasoning Content Display** command is gone — reasoning effort is the Copilot model-picker dropdown.

## Failover

If the primary model hits 429/529, 404, an empty stream, or a slow first token, the **current turn** routes to the backup (default **Nemotron 3.5 Lightning 30B**). The next turn goes back to your primary. When the in-chat notice is on, you see `⚡ NVIDIA NIM Fallback: …` instead of a dead turn.

## Context

Long threads compact with `nvidia-nim.context.summarizationModel`, not the fallback model. Large windows get an extra safety margin so a 256K+ payload does not overflow on the next tool turn.

## Marketplace

- Name on the card is **NVIDIA NIM Agent**.
- Install from [the Marketplace](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent) or Quick Open: `ext install neuraldock.nvidia-nim-agent`.
- README includes a demo GIF of Agent + Nemotron 3.5 Lightning writing a TypeScript file with native thinking.

## Install

[Install NVIDIA NIM Agent](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent), or download `nvidia-nim-agent-0.6.0.vsix` and use **Install from VSIX...**.
