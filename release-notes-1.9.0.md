# v1.9.0 — MiniMax M3.1 Flash

This release adds MiniMax M3.1 Flash to the model picker and improves context limit recovery when NVIDIA returns its newer structured error response.

## New Model

* **MiniMax M3.1 Flash.** A fast multimodal model for everyday coding, tool use, and visual input, with a 262,144-token context window on NVIDIA NIM, up to 65,536 output tokens, tool calling, and image input. Reasoning Mode offers `Low`, `Medium`, `High`, `XHigh`, and `Max`, and its thinking is adaptive so short questions can be answered without a long delay while harder tasks show their reasoning in the Thinking block. It scores 43 on the Artificial Analysis Intelligence Index and can also be selected as your backup, vision backup, or summarization model in the VS Code Settings UI or `settings.json`.

## Fixed

* **Automatic conversation compaction on newer context-limit errors.** When a conversation exceeds a model's context window and NVIDIA returns its newer structured error response, the extension now recognizes it as a context limit error and shortens the conversation automatically instead of stopping the turn.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.9.0.vsix` package.
