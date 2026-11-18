# v1.13.0 — Kimi K3.1 Pro and faster long chats

This release adds Kimi K3.1 Pro, removes DeepSeek V4.1 Flash after NVIDIA retired it, and stops long conversations from slowing down on every turn.

## New

* **Kimi K3.1 Pro.** Moonshot AI's new model is in the model picker: 1M-token context, up to 65,536 output tokens, tool calling, and image input. Reasoning can be `None` (off), `Low`, `High`, or `Max`. It fits long-context agentic coding and work across a whole repository. NVIDIA accepts up to 10 images per conversation for it, so older images past that are replaced with a short note instead of failing the request. It can also be picked as a backup, vision backup, or summarization model.

## Removed

* **DeepSeek V4.1 Flash.** NVIDIA retired it on November 16, 2026, and it no longer answers. No DeepSeek model is in the list right now. If it was your backup or summarization model, the default model is used instead; pick another one in the VS Code Settings UI or `settings.json` if you prefer.

## Fixes

* **Long conversations stay fast.** Once a chat passed 85% of its context size, the extension summarized the older turns again before every request. That added several seconds to each turn and kept the model from reusing the start of the previous request. Compaction is now left to Copilot Chat, which does it once and keeps the summary; the extension only compacts by itself when a request would not fit at all.
* **Status bar matches the picker.** The context usage in the status bar is now measured against the context size picked in the model picker. With 128K picked on a 1M model it shows `18.3k/128k` instead of `18.3k/1.0M`. Token counts also drop a trailing `.0`, so the status bar reads `128k` and `1M`.
* **Screenshots survive a failover.** When a model that reads images fails in a chat where a tool returned an image, such as a screenshot, the backup is now a model that can read images too. Before, a text-only backup could be picked and the image was dropped without notice.
* **Quieter output log.** A summarization model that is no longer in the model list is reported once in the NVIDIA NIM output log instead of on every request.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.13.0.vsix` package.
