# v1.6.0 — Corrupted Reply Notice, Quicker Return After Overloads

This release points out replies that a broken model deployment has garbled, sends you back to your chosen model sooner after a capacity error, and explains the Copilot and Local chat modes in the troubleshooting guide.

## What changed for you

* **Notice on garbled replies.** Sometimes a model's deployment on NVIDIA's side breaks and its replies come back with raw template tokens such as `<|close|>` scattered through the text. A short note now follows such a reply. It says the deployment is likely producing corrupted output and that switching to another model should help. Tokens inside code blocks or inline code are ignored, so replies that discuss chat templates are not flagged.
* **Back to your model after an overload.** When a model is at capacity ("ResourceExhausted"), the request still moves to your backup model right away. Your next message now tries the model you picked again, instead of staying on the backup for two minutes. These overloads usually clear within seconds. Failover is controlled by `nvidia-nim.fallback.enabled` in the VS Code Settings UI or `settings.json`.
* **Extension notes stay out of the conversation.** Models no longer see the extension's own chat notes in the conversation history, such as the note about a repeated tool call. Some models copied these notes into their later replies.
* **Copilot and Local chat modes explained.** Recent VS Code builds can move chat into the Copilot mode without you changing anything. In that mode the Context Size option is missing and replies appear only after the model finishes. The troubleshooting guide now shows where to switch back to Local and how to make Local the default.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.6.0.vsix` package.
