# NVIDIA NIM Agent for VS Code

<div align="center">

[![Install](https://img.shields.io/badge/Install-Marketplace-007ACC?style=flat&logo=visual-studio-code&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent)
[![Version](https://img.shields.io/visual-studio-marketplace/v/neuraldock.nvidia-nim-agent?color=76B900&label=Version&logo=nvidia&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent)
[![Documentation](https://img.shields.io/badge/Docs-Configuration_Guide-green?style=flat&logo=markdown&logoColor=white)](docs/README.md)
[![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-Chat_Native-181717?style=flat&logo=githubcopilot&logoColor=white)](https://github.com/features/copilot)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Direct access to NVIDIA NIM reasoning models inside GitHub Copilot Chat. No proxy servers in between.

[Install](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent) • [Documentation](docs/README.md) • [Supported Models](#supported-models) • [Quick Start](#quick-start) • [FAQ](#frequently-asked-questions) • [Commands](#extension-commands)

<br/>

<img src="images/demo.gif" alt="NVIDIA NIM Agent in VS Code Copilot: Nemotron 3.5 Lightning writes a TypeScript BST balancer" width="800" />

</div>

NVIDIA provides free API on [build.nvidia.com](https://build.nvidia.com/models). You can run DeepSeek V4, Nemotron, and Kimi directly inside Copilot without any monthly provider subscription.

---

## Why NVIDIA NIM Agent?

The extension routes Copilot Chat to NVIDIA NIM models with automatic failover, reasoning controls, agent-mode tool support, and a status bar that shows live token use.

---

## Key Features

**Reasoning controls.** Collapsible thinking blocks via VS Code's `LanguageModelThinkingPart`, plus per-turn effort control from `None` to `Max` in the Copilot model dropdown.

**Failover.** When the active model returns 429, 404, 410, an empty stream, or a timeout, the same prompt is rerouted to a backup. A configurable `fallback.priorityList` is tried first; text requests fall back to Nemotron 3 Super 120B and image requests to Muse Glimmer by default. The next turn retries the original model.

**Repetition guard.** Detects degenerate "Let me fix..." output loops mid-stream and ends the turn cleanly instead of spinning forever.

**Tool calls.** A single streaming tag-stack XML scanner handles OpenAI JSON, XML control blocks, and Hermes/Anthropic-style tags. Malformed arguments are auto-repaired through `jsonrepair`, and consecutive duplicate read-only calls are suppressed.

**Context auto-compaction.** Long sessions get compacted in the background by a dedicated model so you don't hit `HTTP 400 Context Window Exceeded`.

**Status bar & diagnostics.** Token utilization in the status bar, prompt/completion counts in Copilot's context window widget, and millisecond TTFT logs when debug logging is on.

---

## Supported Models

The extension connects to official NVIDIA NIM endpoints (`https://integrate.api.nvidia.com/v1`) and ships per-model adapters.

| Model | Intelligence Index | Context Window | Reasoning Modes | Tools | Vision | Notes |
| :--- | :---: | :---: | :--- | :---: | :---: | :--- |
| **Kimi K3** | **60** | 1M | `None`, `Low`, `High`, `Max` | Yes | Yes | Long-context multimodal work, repo-scale jobs |
| **DeepSeek V4 Pro 0813** | **53** | 1M | `None`, `High`, `Max` | Yes | No | High-capacity reasoning, codebase generation |
| **DeepSeek V4 Flash 0731** | **52** | 1M | `None`, `High`, `Max` | Yes | No | Algorithm design, architecture, complex refactors |
| **MiniMax M3** | **45** | 1M | `None`, `On`, `Adaptive` | Yes | Yes | Multimodal coding, full-stack tasks |
| **Nemotron 3 Ultra 550B** | **38** | 1M | `None`, `Medium`, `High` | Yes | No | Heavy multi-step reasoning, technical docs |
| **Muse Glimmer** | **35** | 131K | `None` to `XHigh` | Yes | Yes | Visual UX/UI work; default vision fallback |
| **Nemotron 3 Super 120B** | **26** | 1M | `None`, `Low`, `High` | Yes | No | Workhorse for everyday coding; default text fallback |
| **Nemotron 3.5 Lightning 30B (Unavailable)** | **24** | 1M | `None`, `Medium`, `High`, `XHigh` | Yes | No | Listed on `/v1/models`; picker shows Unavailable while overloaded |

Intelligence Index values are from the Artificial Analysis Intelligence Index (verified; see `CHANGELOG.md` 0.9.2).

---

## Documentation & Settings

The full `settings.json` reference, failover policies, network parameters, and agentic tool configuration live in the dedicated guide:

[Full Documentation & Configuration Guide (docs/README.md)](docs/README.md)

---

## Quick Start

### 1. Install

- [Install from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent), or
- Quick Open (`Ctrl + P` / `Cmd + P`): `ext install neuraldock.nvidia-nim-agent`

### 2. Requirements

- VS Code `1.125.0` or later
- GitHub Copilot, installed and signed in
- An NVIDIA NIM API key (free credits at [build.nvidia.com](https://build.nvidia.com/models))

### 3. Configure Your API Key

1. Open Copilot Chat (`Ctrl + Alt + I` / `Cmd + Alt + I`).
2. Click the model selector dropdown, then **Manage Models**, then **NVIDIA NIM**.
3. Paste your key (`nvapi-...`).

Alternatively, run `NVIDIA NIM: Manage NVIDIA NIM API Key` from the Command Palette.

### 4. Start Chatting

Pick any NVIDIA NIM model in Copilot Chat or Copilot Agent Mode.

---

## Extension Commands

Open the Command Palette (`Ctrl + Shift + P` / `Cmd + Shift + P`).

| Command | Identifier | Description |
| :--- | :--- | :--- |
| Manage API Key | `nvidia-nim.manage` | Store or update your NVIDIA NIM API key in OS SecretStorage. |
| Refresh Models | `nvidia-nim.refreshModels` | Re-sync the available model list and invalidate the local cache. |
| Toggle Debug Logging | `nvidia-nim.toggleDebugLogging` | Toggle verbose diagnostic logs. |
| Open Debug Log | `nvidia-nim.openDebugLog` | Open the NVIDIA NIM Output channel. |

---

## Privacy & Security

All requests go directly from your VS Code client to the official NVIDIA NIM API at `https://integrate.api.nvidia.com/v1`. There are no third-party telemetry endpoints or proxy gateways. The API key is encrypted in VS Code's OS-level `SecretStorage`. The extension stores no chat logs, file contents, or personal credentials.

---

## Frequently Asked Questions

**Do I need a paid NVIDIA subscription?** No. NVIDIA provides free API on [build.nvidia.com](https://build.nvidia.com/models) for developers.

**Does it work with Copilot Agent Mode and Tools?** Yes. The supported chat models are tool-capable and support autonomous file editing, terminal execution, and MCP tools with automatic JSON repair.

---

## License

[MIT](LICENSE).
