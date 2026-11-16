# v1.12.0 — Live status bar and steadier agent turns

This release shows what the model is doing while it works and fixes a set of cases where agent turns stopped early, repeated themselves, or ran a tool from an example.

## New

* **Live status in the status bar.** While a reply is generated, the NVIDIA NIM status bar item shows how long it has been waiting for the first token, the latest sentence of the model's reasoning, and the output speed while it writes or calls a tool. In Copilot sessions the chat shows the reply only after the model finishes, so this is the way to see that a long turn is still moving. The item keeps a steady width and its hover stays still while it updates.
* **Time to first token and speed after each reply.** When a reply ends, the status bar shows the time to first token and the generation speed in tokens per second next to the context usage. The hover has the details.

## Improvements

* **Higher output limit.** Maximum output tokens per response can now be set up to 262,144 in the VS Code Settings UI and `settings.json`, matching the models that support 262K-token answers.
* **Summaries and image descriptions no longer cut off on thinking models.** Conversation summarization and image analysis reserve a larger response budget on models that always think before answering.
* **Clearer error messages.** Requests rejected as too large, in an unsupported media format, or by content screening now say so instead of showing a generic invalid-request error. Conversation compaction also kicks in when NVIDIA reports a context limit this way.
* **More complete turn reports.** `NVIDIA NIM: Save Last Turn Report` now records the exact reasoning effort sent to MiniMax M3.1 Flash and DeepSeek V4.1 Flash.

## Fixes

* **Retries respect your limits.** Background network retries count toward the per-turn request limit, so an unstable connection stops at the configured cap instead of stalling. Token usage in the status bar is kept when a retry stops at that cap.
* **Failover skips retired models.** After NVIDIA reports a model as retired, failover restarts go straight to the first active backup and keep every configured restart attempt. Learned context limits stay separate per API key.
* **Answers stay out of Thinking.** Replies that begin with blank lines no longer end up inside the Thinking block.
* **Repeated output is cut cleanly.** When the model starts looping, the useful part of the answer written before the loop is kept, and Markdown horizontal rules are no longer mistaken for unfinished sentences.
* **Fewer stalled turns from tool calls.**
  * Malformed tool calls inside Thinking are retried instead of ending the turn with an empty reply.
  * Tool calls that leave out only a summary or description note are filled in instead of failing validation.
  * JSON tool calls in code blocks are recovered again, including line-range file reads, error checks with a list of files, and single-argument calls that end a reply after a short lead-in sentence.
  * Windows paths that start with a backslash are kept intact.
* **Examples stay examples.** Tool-call examples inside code blocks, including blocks in lists, task lists, and quotes, are no longer run as real tool calls.
* **Repeat detection fits real workflows.** A model calling two read or search tools back and forth with the same arguments is stopped. Reading a file again after a real change (an edit, a symbol rename, a notebook cell run, or a terminal command) is no longer blocked. Chats working on different tasks no longer share loop recovery.
* **Long conversations keep tool calls paired.** Trimming a very long, tool-heavy conversation keeps the assistant's tool call together with its result.
* **Credentials stay hidden.** API keys and bearer tokens are redacted from status bar error tooltips.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.12.0.vsix` package.
