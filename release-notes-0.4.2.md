# v0.4.2

VS Code extension that integrates the best models from NVIDIA NIM into GitHub Copilot Chat. Get access to powerful models like DeepSeek, Kimi, GLM, Nemotron, MiniMax, and Stepfun right in your editor.

## What's New in 0.4.2

- **Streaming fixed for MiniMax M3 and Kimi K2.6.** Responses now stream token-by-token in real time, instead of buffering the entire answer and dumping it all at once at the end.
- **Reasoning tokens no longer split the answer.** When the API sends reasoning and content in the same chunk, reasoning is now processed first — so it stays in the thinking block and the answer text stays intact.
- **MiniMax M3 reasoning modes work now.** None, On, and the new **Adaptive** mode are correctly sent to the model. Previously the parameter was in the wrong format and silently ignored.
- **Kimi K2.6 reasoning toggle works now.** The On/Off switch was being sent at the wrong level of the request, so the model never saw it.
- **No more corrupted answers when the model mentions think-tags in code.** If a model like DeepSeek or MiniMax quoted literal `<think>` or `<mm:think>` strings while analyzing source code, the tag filter would mistake them for real reasoning tags and tear the response apart. The filter is now disabled for models that use `reasoning_content`; content passes through untouched.
- **MiniMax M3 reasoning is now visible.** The model's native `<think>/</think>` and `<mm:think>/</mm:think>` tags are recognized and rendered as collapsible thinking blocks.

## Install

Download the `.vsix` below -> Extensions view -> **Install from VSIX...**

Requires VS Code 1.125+, GitHub Copilot, and an API key from [build.nvidia.com/models](https://build.nvidia.com/models).
