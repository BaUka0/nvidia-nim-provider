# v1.1.0 — Agent Loop Breaker, Transient Overload Recovery, and Formatting Resilience

This update improves reliability during complex Copilot agent workflows and autonomous tasks. It introduces language-agnostic narrative loop detection, exponential backoff for transient server overloads, false positive elimination for code comment dividers and markdown tables, and automatic catalog cache invalidation.

## What changed for you

* **Resilient agent tool execution and loop recovery.** Fixed issues where models could get caught in repetitive conversational preambles (such as repeating "Let me check..." or planning steps across turns) instead of calling tools. A language-agnostic loop detector identifies repeating preamble patterns across languages and nudges the model to execute tools immediately. Trailing unexecuted preambles are automatically removed from retry history to prevent models from reinforcing their own loops.
* **Transient overload and disconnect recovery.** When NVIDIA NIM servers experience temporary load spikes (HTTP 529, 503, 429) or network interruptions during generation, retries now use exponential backoff with pause intervals rather than firing immediately, giving server queues time to shed load. If every backup model encounters a transient error before an answer is displayed, the failover chain pauses and restarts from the initial model.
* **Divider and table formatting preservation.** Fixed false positive loop detections on code comment dividers (such as PEP-8 section banners with repeating hyphens or equal signs) and markdown table borders. These sequences are now recognized as valid formatting and will no longer prematurely abort the stream.
* **Automatic model list updates.** New and updated models from NVIDIA NIM now reach existing installations automatically on next launch without requiring you to manually run the Refresh Models command.
* **Autonomous agent setup guidance.** Added documentation and watchdog timeout recommendations for running long autonomous agent tasks in VS Code's Agents window (`chat.agentHost.byokModels.enabled`).

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.1.0.vsix` package.
