# v1.9.1 — Step 5 Preview Multi-Step Agent Reliability

This release resolves mid-task turn stops and malformed tool argument handling during long multi-step agent sessions on Step 5 Preview.

## Fixed

* **Uninterrupted multi-step agent runs on Step 5 Preview.** Long agent sessions on Step 5 Preview no longer stop mid-task by replying with `(empty message)`, `[Request interrupted by user]`, or raw tool parameter tags instead of running the next tool. Earlier empty or interrupted assistant turns are omitted from the conversation history sent to the model, echoed placeholder lines and whitespace-only replies are retried automatically, and tool argument tags with stray quotes are parsed and executed cleanly.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.9.1.vsix` package.
