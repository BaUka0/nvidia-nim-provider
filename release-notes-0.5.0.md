# v0.5.0

## No more silent "no response" failures

The biggest change in this release is reliability you can feel. Previously, when a model stalled mid-thought or the connection dropped without a proper ending, Copilot Chat would just show a dead-end **"Sorry, no response was returned"** — with no explanation and no way to recover except starting over. The extension now recognizes these situations itself:

- If a response ends without producing any visible answer or action, the extension quietly **retries the request on its own**, giving the model a second chance. Many "frozen" turns now simply continue as if nothing happened.
- If the model spent a long time thinking but never produced an answer or a tool call (a known NVIDIA NIM stall), you now get a **clear, actionable message** instead of silence — telling you to try again, lower the reasoning effort, or switch models.
- Crucially, a long thinking-only stall is **not** blindly repeated several times, so you are never stuck waiting through multiple multi-minute timeouts.

## The agent keeps working through hiccups

In Agent mode, the model works in steps (reading files, running tools, then continuing). An interrupted step used to abort the whole task. Now an empty or aborted step is recovered automatically, so long multi-step tasks are far less likely to die halfway through.

## Cleaner and more stable under the hood

- Removed leftover internal planning documents and fixed a batch of pre-existing code-quality warnings, so builds and checks are clean.
- Debug logs now record exactly how each streamed response ended (visible answer vs. thinking-only vs. empty), which makes any future issue much faster to diagnose.

## Install

Download the `nvidia-nim-agent-0.5.0.vsix` file and install it from the VS Code Extensions view using **Install from VSIX...**
