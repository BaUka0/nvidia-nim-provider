# v0.10.2 — Catalog cleanup and tool-loop stop

This release removes MiniMax M3 after NVIDIA dropped it from the NIM catalog, stops Agent Mode from repeating the same tool call forever, and updates documented capability scores to Artificial Analysis Intelligence Index v4.3.

## What changed for you

* **MiniMax M3 is gone from the picker.** NVIDIA removed the model from the NIM catalog, so it is no longer offered as a chat model or as an automatic fallback. Image requests still fall back to Muse Glimmer; Kimi K3 remains the other curated vision model.
* **Repeated tool calls stop.** If a model keeps calling the same tool with the same arguments, the extension nudges it once and then ends that turn instead of looping in Agent Mode.
* **Benchmark scores.** Documentation now uses Artificial Analysis Intelligence Index v4.3 scores for the remaining curated models.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.10.2.vsix` package.
