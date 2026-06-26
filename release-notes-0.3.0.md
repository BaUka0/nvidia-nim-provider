# v0.3.0

VS Code extension that adds NVIDIA NIM models to GitHub Copilot Chat. Useful when Copilot Student subscription loses premium models — gives access to DeepSeek, Kimi, GLM, Nemotron, MiniMax, and Stepfun via free NVIDIA NIM API credits.

## Since 0.2.0 — what changed ideologically

The extension evolved from a generic "show all NVIDIA models" wrapper into a focused, deeply integrated reasoning provider.

- **Curated model set** — dropped 8 generic adapters (Llama, Claude, GPT, Mistral, Qwen, Phi, Yi, Gemma) in favor of 6 elite agentic models with per-model tuning: temperature profiles, tool-calling system prompts, and reasoning configuration
- **Native reasoning** — `reasoning_content` and Kimi's ` think` tags are now rendered as collapsible `LanguageModelThinkingPart` blocks in VS Code, not dumped as raw text
- **Per-model reasoning picker** — each model exposes its own reasoning modes in the Copilot Chat dropdown (DeepSeek: High/Max, Nemotron: Medium/High, Kimi/GLM/MiniMax: On/Off)
- **Resilience** — auto-fallback on rate limit, streaming retry on network drop, context compression on overflow. The extension now recovers from failures instead of throwing hard errors
- **Visibility** — token usage in status bar, debug logging, proper error messages with actionable guidance

## What's New in 0.3.0

- **Token usage in status bar** — shows prompt→completion tokens after each response (`Kimi k2.6: 1.2k→850`)
- **Auto-fallback on rate limit** — 429 automatically retries with DeepSeek V4 Flash
- **Stream retry on network error** — retries up to 2 times if connection drops mid-response
- **Context compression** — long conversations are summarized via API instead of throwing a hard error
- **Think-tag reasoning capture** — Kimi's ` think` tags now rendered as collapsible thinking blocks
- **Project cleanup** — removed 11 dead shim files, legacy OcGo naming, 0 lint errors

## Install

Download the `.vsix` below → Extensions view → **Install from VSIX...**

Requires VS Code 1.125+, GitHub Copilot, and an API key from [build.nvidia.com/models](https://build.nvidia.com/models).
