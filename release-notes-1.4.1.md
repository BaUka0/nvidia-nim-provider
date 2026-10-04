# v1.4.1 — Nemotron 3 Super Returns and Reasoning Choice in Copilot Sessions

This patch release brings Nemotron 3 Super 120B back to the model picker and lets you choose the reasoning level for NVIDIA NIM models in Copilot agent sessions on VS Code 1.140.

## What changed for you

* **Nemotron 3 Super 120B returns.** Version 1.4.0 removed the model after NVIDIA retired it on October 3, 2026; NVIDIA restored it the next day, and it works normally again. It is back in the Copilot Chat model picker with the same setup as before 1.4.0: a workhorse for everyday coding with a 1M-token context window and `None`, `Low`, and `High` reasoning modes. It was checked against NVIDIA's service before this release, including reasoning, tool use, and long conversations close to the full context window.
* **Your defaults stay the same.** Nemotron 3.5 Lightning 30B remains the default backup model and the model that summarizes older conversation history. You can pick Nemotron 3 Super for either role in the VS Code Settings UI or `settings.json` (`nvidia-nim.fallback.model` and `nvidia-nim.context.summarizationModel`).
* **Reasoning level in Copilot agent sessions.** VS Code 1.140 runs Copilot agent sessions separately from regular local chat, and there it only showed a Thinking Effort choice for models that describe it in a standard way. NVIDIA NIM models now do, so the choice appears next to the model name in Copilot agent sessions as well, and the level you pick is applied to the request. In local chat sessions the control works as before. A reasoning level you picked earlier resets to the default once after updating. Context Size remains available in local chat sessions only, because Copilot agent sessions do not support it for any model.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.4.1.vsix` package.
