# v1.3.0 — Model Picker Context Controls, Text JSON Tool Recovery, and Stream Resilience

This minor release introduces flexible context size selection and full context window visibility in the Copilot Chat model picker, enables reasoning by default across supported models, recovers text-formatted tool calls, and improves streaming resilience against connection drops.

## What changed for you

* **Full context window and context size control.** The Copilot Chat model picker now displays the full context window for each NVIDIA NIM model, matching the chat context usage indicator. For models with large context windows, a new Context Size option lets you select a smaller working budget (128K, 256K, or 512K) to keep responses fast and trigger earlier conversation summarization. The default remains the full window.
* **Reasoning enabled by default.** Models with thinking capabilities now run with reasoning turned on out of the box (High for most models, and Medium for Nemotron 3.5 Lightning). You can switch modes at any time in the model picker, or change the default through `nvidia-nim.reasoning.mode` in the VS Code Settings UI or `settings.json`.
* **Automatic recovery for text and fenced tool calls.** If a model outputs function calls formatted as JSON text or within markdown code fences instead of native structured parts, the extension intercepts and executes them automatically, keeping normal conversation text in chat.
* **Auto-continue on dropped streams.** When an upstream connection drops prematurely before the model signals completion, the extension preserves what was already generated and prompts the model to pick up where it left off, rather than failing the turn.
* **Calmer agent nudges and loop guard tuning.** Repetition detection in thinking and answers has been calibrated to avoid false positives on legitimate repeated phrases, tool names, section headings, or quoted code lines. Reminders for interrupted turns and retries use calm, task-focused instructions.
* **Model alignment and output limits.** DeepSeek V4.1 Flash can now output up to 256K tokens per response. Nemotron 3 Super and Ultra response limits are set to the 32K tokens from their model cards. Background tasks like conversation summaries and image analysis run with reasoning turned off to preserve their token budgets.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.3.0.vsix` package.
