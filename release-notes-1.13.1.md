# v1.13.1 — Muse Glimmer Removed

NVIDIA retired Muse Glimmer on November 23, 2026. It is gone from NVIDIA's model list and every request to it now fails, so this release removes it from the model picker.

## What changed for you

* **Muse Glimmer is gone from the model picker.** Pick another model for your chats.
* **Default vision backup updated.** Nemotron 3.5 Super VL is now the default backup model for requests with images.
* **Backup and summarization settings.** If Muse Glimmer was set as your backup, vision backup, or summarization model, the extension uses the default model instead. You can choose a different one in the VS Code Settings UI or `settings.json`.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.13.1.vsix` package.
