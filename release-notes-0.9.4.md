# v0.9.4 — Session logs in one file

This release makes it easier to send a useful diagnostic file after a bad chat turn. You do not need to turn on verbose debug logging first, and the default log no longer dumps every stream chunk or your prompt text.

## What changed for you

* **Save Session Logs.** After a problem, open the Command Palette and run **NVIDIA NIM: Save Session Logs**. One JSON file is written to your Downloads folder. It includes recent turns, technical events (retries, tool names, finish reasons), and a few settings. Attach that file to a GitHub issue. **NVIDIA NIM: Save Last Turn Report** still works and does the same thing.
* **Quieter debug log.** With debug logging on, the Output panel shows technical details only. Stream chunk dumps and outgoing chat message bodies stay off unless you enable them.
* **Optional extras.** In the Settings UI or `settings.json`, `nvidia-nim.developer.logStreamChunks` includes per-chunk stream dumps, and `nvidia-nim.developer.logUserMessages` includes outgoing message bodies. Both default to off. Leave them off unless you are asked for that level of detail.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.9.4.vsix` package.
