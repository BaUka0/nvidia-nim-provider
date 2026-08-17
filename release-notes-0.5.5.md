# v0.5.5

## Agent turns that keep going

This release is about Copilot Agent mode actually finishing a job. Models on NVIDIA NIM often *meant* to search, compile, or read a file, but the tool call never reached VS Code. The chat then stopped on a line like “Let me search…” — that is what [issue #2](https://github.com/BaUka0/nvidia-nim-provider/issues/2) reported.

Part of the fix is on NVIDIA’s side of the wire: their docs require `tool_choice` whenever `tools` is set. We were sending the tool list without it, so the hosted parser often left an empty `tool_calls` field and dumped the call as text. We now always send `tool_choice: "auto"` (or `"required"` when Copilot asks for a tool). After that, native `run_in_terminal` / `read_file` / search calls started landing.

The rest is local: a second search or a second compile is allowed, a missing `isRegexp` on grep is filled in, and internal “this tool was skipped” notes go back to the model instead of into the chat.

## Agent / tools

- **Searches can run in a row.** Repeating `grep` / search / find with the same query no longer kills the turn. A missing `isRegexp` flag defaults to `false` so Copilot does not reject the call.
- **Compile again works.** `run_in_terminal` (and write/edit) can run with the same command as last time. Only identical `read_file` ranges are still treated as already done — and then the model is asked for different line numbers, silently.
- **Native tool calls from NIM are accepted** even when the id is missing, arguments arrive as an object, or the payload sits on `message.tool_calls` instead of `delta`.
- **Tool schemas sent to the model are slimmer.** Copilot-only fields such as `goal` / `explanation` / `mode` are not required on the wire. Descriptions are short. That cut a large chunk of tool-definition tokens and made the NVIDIA parser more likely to succeed.
- **If a tool call is skipped**, the repair hint is a hidden retry to the model, not a paragraph in the chat.

## Leaks and broken edits

- File edits that contain string literals like `"</tool_call>"` or `const token = "<tool_calls>";` are no longer truncated or dumped into the chat as `";` plus the rest of the file.
- Raw XML tool tags and model control tokens (DSML, Llama, ChatML, GLM) stay out of the visible reply when they are real protocol junk. The same tokens inside quotes or regexes are left alone.

## Fallback (unchanged from 0.5.4)

Automatic fallback is still **only** for HTTP 429 / 529 (and 404 unavailable). It switches to **Nemotron 3.5 Lightning 30B**, not DeepSeek Flash. A model that answers with plain text instead of another tool call is a finished turn, not a failover.

## Install

Download `nvidia-nim-agent-0.5.5.vsix` and install it from the Extensions view (**Install from VSIX...**). If you already had 0.5.4, replace that install. Then run **NVIDIA NIM: Refresh Models** if the picker looks stale.

Debug logs live in Output → **NVIDIA NIM** (not “NVIDIA NIM Provider”). Turn them on with **NVIDIA NIM: Toggle Debug Logging**.
