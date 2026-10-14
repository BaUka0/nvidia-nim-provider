# v1.6.1 — Images From Tools, Steadier Agent Sessions

This release fixes how screenshots from tools reach the model, closes several gaps in text tool calls and long-conversation summaries, stops false loop corrections in agent sessions, and keeps rate-limited requests from failing as timeouts.

## What changed for you

* **Images returned by tools.** Screenshots and other images from tools now reach models that accept images. Before, the model got the raw image bytes as text, cut off at the tool output limit, which wasted context and told the model nothing. Models without image input get a short note that an image was returned.
* **Code blocks at the end of an answer.** An answer that ends with a code block keeps its closing fence. Before, the last three backticks could be dropped, leaving the block open.
* **Tool calls written as text.** Models that write tool calls as plain text handle more cases. A call split mid-name across the stream is no longer printed into the chat, an example call inside a code block is no longer run, a real call after such an example is no longer missed, and a call cut off right after its last argument is still run.
* **Your latest message in long conversations.** When a long conversation is summarized to fit the model, your latest message is kept word for word, even when it is long, such as a pasted file. A message too large for the model on its own, such as a huge attached log, goes into the summary with its end kept, since that is usually where the question is. When older history is too large to summarize in full, the oldest turns are now the ones left out, so the summary keeps what happened most recently.
* **Rate limits no longer end as timeouts.** When NVIDIA asks to retry after a pause longer than the first token timeout, the request now waits and retries. Before, it failed with a "no data received" timeout and moved to the next model even though the original model was fine.
* **No false loop corrections.** Agent sessions no longer get a "you have repeated the preamble" correction just because several replies open the same way, such as "Now I'll…". The correction now applies only to replies that stop at an announcement like "Let me check the page:" without doing it, and each new message you send gets a fresh allowance.
* **API keys stay with their group.** With several API key groups, a model whose key group was removed or changed now asks for a key instead of quietly using another group's key, which could send the request under a different account.
* **Model settings left empty.** A model setting set to `null` or another non-text value in `settings.json` now falls back to the default model instead of making every request fail.
* **Session logs with "Log User Messages" on.** Saved session logs stay within their size limit even with large requests and images. A very large request is saved as its latest part, and request bodies are dropped before the events needed to diagnose a problem.
* **Keeping new chats in Local mode.** The troubleshooting guide now lists both VS Code settings that move new chats into Copilot mode, how to bring back a missing Local option, and what to do when your organization controls it. These settings are available in the VS Code Settings UI and `settings.json`.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.6.1.vsix` package.
