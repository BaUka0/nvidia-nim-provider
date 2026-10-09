# v1.5.0 — Resumed Reasoning, Faster Failover and Richer Turn Reports

This release makes long reasoning survive interruptions, moves away from busy models sooner, and makes agent sessions easier to diagnose when something goes wrong.

## What changed for you

* **Long reasoning picks up where it stopped.** When a reply stalls, loses its connection, or hits the output limit while the model is still thinking, the retry now shows the model the end of its own reasoning, so it continues from there. Before, the model never saw that reasoning and started the whole analysis over. On slow models with a high reasoning level this could repeat until the turn came back empty and switched to another model. The same applies when a model finishes thinking without writing an answer or calling a tool.
* **Cleaner recovery instructions.** When the extension steps in to get a stuck or looping model moving again, its message no longer contains bracketed internal tags. Some models read those tags as part of the instruction and discussed them in their reasoning instead of continuing the task. A model whose thinking starts repeating itself now gets a short instruction to move on.
* **Busy models hand off right away.** When NVIDIA reports that a model is at capacity, the request moves to your backup model immediately instead of retrying the busy model for several seconds first. The busy model is then skipped for two minutes, so the following steps of an agent session do not wait on it again. This works when failover is enabled (`nvidia-nim.fallback.enabled` in the VS Code Settings UI or `settings.json`). The chat notice now says "Overloaded" for these cases.
* **More useful turn reports.** Save Last Turn Report now records which tools the model called, whether each turn followed tool output or a new message, and whether it came from a Copilot agent session or a local chat session. Agent sessions that stop right after a tool call are much easier to diagnose from a single report.
* **Clearer message when there is nothing to save.** With several VS Code windows open, Copilot agent sessions from every window are served through the window you opened first, so the other windows have no reports. Save Session Logs and Save Last Turn Report now say so when they find nothing to save.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.5.0.vsix` package.
