# v1.9.3 — GLM 5.3 Removed

NVIDIA retired GLM 5.3 on October 28, 2026. It is gone from NVIDIA's model list and every request to it now fails, so this release removes it from the model picker.

## What changed for you

* **GLM 5.3 is gone from the model picker.** Pick another model for your chats. GLM 5.3 Flash, a fast reasoning model with a 1M context window, image input, and `Low`, `High`, and `Max` reasoning modes, stays in the list.
* **Backup and summarization settings.** If GLM 5.3 was your backup or summarization model, the extension uses the default model instead. You can choose a different one in the VS Code Settings UI or `settings.json`.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.9.3.vsix` package.
