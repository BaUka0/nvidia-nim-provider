# v1.9.2 — Step 5 Preview Tool Argument Recovery

This release fixes another case where Step 5 Preview could stop mid-turn during multi-step agent sessions instead of running the next tool.

## Fixed

* **Tool calls with stripped argument tags on Step 5 Preview.** Sometimes Step 5 Preview writes tool arguments in a format that NVIDIA's server only partly understands, and the server drops the surrounding tool call markup. The leftover argument lines used to show up as plain text and end the turn. They are now put back together into the intended tool call, so the agent keeps working. Leftover argument lines from earlier turns are also removed from the conversation history, so the model does not copy them in later replies.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.9.2.vsix` package.
