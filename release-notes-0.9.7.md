# v0.9.7 — Unknown tool calls no longer end the turn

This is a small hotfix. If the model calls a tool Copilot does not have, the chat no longer stops after a short preamble.

## What changed for you

* **Skipped unknown tools.** The extension retries that turn more than once and then failsover to the backup model, instead of treating the preamble as a finished answer.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.9.7.vsix` package.
