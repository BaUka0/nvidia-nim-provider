# v0.11.1 — Live Reasoning Streaming and Failover Stability

This release streams reasoning tokens live to the thinking display during deep thought phases, eliminates perceived UI freezes, guarantees dedicated connection attempts for automatic failover, and refines tool call handling in Agent Mode.

## What changed for you

* **Live reasoning stream.** Model reasoning is now displayed in real time as tokens arrive instead of buffering until the answer begins. Deep thinking phases with models such as GLM 5.3 Flash no longer appear frozen in Copilot Chat.
* **Guaranteed failover attempts.** When switching away from an overloaded primary model, automatic model failover is now allocated dedicated connection attempts, preventing retries from exhausting the turn before backup models can run.
* **Configurable connection attempt budget.** You can now tune how many total connection attempts are allowed per chat turn with the `nvidia-nim.network.maxTotalFetchAttempts` setting (available in VS Code Settings and `settings.json`, default 6, range 2 to 30).
* **Accurate tool deduplication in Agent Mode.** Diagnostic tools and test runners are no longer mistakenly dropped as duplicate file reads during complex agent turns.
* **Safer tool error recovery.** In-turn retries triggered by malformed tool calls are now capped at two attempts before failing over to a backup model, avoiding infinite retry loops.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.11.1.vsix` package.
