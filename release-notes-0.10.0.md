# v0.10.0 — Tool recovery stays in the conversation

This release is about keeping the chat moving when a turn goes wrong. File reads, bad tool calls, loops, and context overflow recover with the model or the backup model instead of printing a diagnostic in the transcript.

## What changed for you

* **File reads.** If the model names a file but skips line numbers, the extension fills a default range and sends the call. If the path is still missing, the model is asked again. You should not see a rejection about missing `startLine` / `endLine` in chat.
* **Bad tool calls.** A call that cannot be repaired is retried with the model, then handed to the backup model. The failover notice says Invalid tool call, not Empty response.
* **Loops, cut-off replies, and safety filters.** After a partial answer with no tool call, the model is nudged to continue (when auto-continue is on). Those cases no longer print a Stopped early or token-limit notice in chat.
* **Reasoning settings.** If you pick a reasoning mode the model does not support, reasoning is turned off for that request instead of silently switching to another effort level.
* **Save Last Turn Report.** Command Palette **NVIDIA NIM: Save Last Turn Report** now writes its own report file. **NVIDIA NIM: Save Session Logs** still writes the session log. Each command explains when there is nothing to save yet.
* **Long chats.** After history is compacted, empty-stream and invalid-tool recovery still run, and a failed compaction tells you to start a new chat instead of showing a raw server error.
* **Settings during a reply.** Changing a setting while a response is streaming no longer changes how that in-flight reply is assembled or retried. The new value applies on the next message.
* **MiniMax and similar tool-enabled models.** They get the same instruction as the rest of the catalog not to wrap answers in XML or Copilot content-ref links.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.10.0.vsix` package.
