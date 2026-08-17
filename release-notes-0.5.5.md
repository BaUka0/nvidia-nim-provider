# v0.5.5

## Tool calling that actually reaches Copilot

NVIDIA NIM models often intended to call a tool, but the call never arrived as a native `tool_calls` payload. The hosted API expects `tool_choice` whenever `tools` is set; we were sending the tool list without it, so the server-side parser frequently left `tool_calls` empty and the turn ended.

This release always sends `tool_choice: "auto"` (or `"required"` when Copilot requires a tool), slims the schemas the model sees, and keeps the agent going when it searches or compiles more than once.

## Agent / tools

- **Native NIM tool calls are accepted** when the id is missing, arguments arrive as an object, or the payload sits on `message.tool_calls` instead of `delta`.
- **Tool schemas sent to the model are shorter.** Copilot-only fields such as `goal`, `explanation`, and `mode` are not required on the wire. Descriptions no longer repeat the full schema. That cuts tool-definition tokens and makes the NVIDIA parser more likely to succeed.
- **Searches can run in a row.** Repeating grep / search / find with the same query is allowed. A missing `isRegexp` flag defaults to `false` so Copilot does not reject the call.
- **Compile again works.** `run_in_terminal` (and write / edit) can run with the same command as last time. Only an identical `read_file` range is treated as already done; the model is then asked for different line numbers.
- **Skip / repair hints go to the model**, not into the chat.

## Leaks and broken edits

- Edits whose contents include literals like `"</tool_call>"` or `const token = "<tool_calls>";` are no longer truncated or spilled into the chat.
- Raw XML tool tags and control tokens (DSML, Llama, ChatML, GLM) are stripped from the visible reply. The same tokens inside quotes or regexes are left alone.

## Fallback (unchanged from 0.5.4)

Automatic fallback is only for HTTP 429 / 529 and 404 unavailable. It switches to **Nemotron 3.5 Lightning 30B**, not DeepSeek Flash.

## Install

Download `nvidia-nim-agent-0.5.5.vsix` and install it from the Extensions view (**Install from VSIX...**). If you already had 0.5.4, replace that install. Run **NVIDIA NIM: Refresh Models** if the picker looks stale.

Debug logs: Output → **NVIDIA NIM**. Enable with **NVIDIA NIM: Toggle Debug Logging**.
