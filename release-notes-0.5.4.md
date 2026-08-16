# v0.5.4

## New Flash, a small fallback, and answers that actually stream

NVIDIA pulled the old DeepSeek V4 Flash and V4 Pro endpoints. This release switches you to the replacement Flash, adds a light model for when that one is overloaded, and fixes two reply-routing bugs that hid or delayed the visible answer.

## Models

- **DeepSeek V4 Flash 0731** is the new curated Flash. In the picker it is labeled **DeepSeek V4 Flash 0731** so it is not confused with the withdrawn ID. Same 1M-class context, tool calling, and None / High / Max reasoning.
- **DeepSeek V4 Flash** (`deepseek-ai/deepseek-v4-flash`) and **DeepSeek V4 Pro** are gone from NVIDIA NIM and from this extension.
- **Nemotron 3.5 Lightning 30B** is in the picker and is now the automatic fallback. It is a small, fast text model (30B total / 3B active) with a probed 1,000,000-token context and a 32,768-token output cap. No vision.

Flash 0731 is currently the endpoint that returns 429 / 529 under load, so using it as the fallback would go nowhere. Lightning is the spare tire: rate-limit recovery, overload recovery, and conversation summarization when a long thread overflows.

Lightning reasoning in the picker is **None / Medium / High / XHigh**. Those send `enable_thinking` plus a `reasoning_budget` of 0 / 50% / 80% / 95% of the request output limit (max 32,768), the same split OpenRouter uses.

After install, run **NVIDIA NIM: Refresh Models** so the old Flash / Pro cache is dropped.

## When the primary model is full

- HTTP **429** still falls back to Lightning.
- HTTP **529 Overloaded** (`Service temporarily overloaded`) now does the same, after the usual retries. You get an **Overloaded on … Falling back to Nemotron 3.5 Lightning 30B** toast instead of a dead `[SERVER_ERROR]`.

## Replies

- If you pick High (or any isolated reasoning mode) and the model just answers — no `reasoning_content`, no think tags — that answer stays in the chat. It is no longer stuffed into a collapsed thinking block and no longer fails as `[EMPTY_STREAM]`.
- After thinking finishes, the visible answer streams token by token. It no longer waits for the whole completion and then appears in one dump.

## Install

Download the `nvidia-nim-agent-0.5.4.vsix` file and install it from the VS Code Extensions view using **Install from VSIX...**
