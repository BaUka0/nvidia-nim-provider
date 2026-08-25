# NVIDIA NIM Agent for VS Code

<div align="center">

[![Install](https://img.shields.io/badge/Install-Marketplace-007ACC?style=flat&logo=visual-studio-code&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent)
[![Version](https://img.shields.io/badge/Version-v0.7.0-76B900?style=flat&logo=nvidia&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent)
[![Documentation](https://img.shields.io/badge/Docs-Configuration_Guide-green?style=flat&logo=markdown&logoColor=white)](docs/README.md)
[![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-Chat_Native-181717?style=flat&logo=githubcopilot&logoColor=white)](https://github.com/features/copilot)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Direct, zero-markup access to NVIDIA NIM's premier open & proprietary reasoning models right inside GitHub Copilot Chat.**

[Install](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent) • [Documentation](docs/README.md) • [Supported Models](#-supported-models) • [Quick Start](#-quick-start) • [FAQ](#-frequently-asked-questions) • [Commands](#-extension-commands)

<br/>

<img src="images/demo.gif" alt="NVIDIA NIM Agent in VS Code Copilot: Nemotron 3.5 Lightning writes a TypeScript BST balancer" width="800" />

</div>

> **Free Access:** NVIDIA provides free developer API at [build.nvidia.com](https://build.nvidia.com/models). You can use DeepSeek V4, Nemotron, and Kimi directly inside Copilot without any monthly provider subscriptions.

---

## 🚀 Why NVIDIA NIM Agent?

Modern software engineering demands high-precision reasoning, long context understanding, and reliable autonomous tool execution. **NVIDIA NIM Agent** connects VS Code directly to NVIDIA's high-throughput NIM Cloud infrastructure, unlocking flagship models with minimal latency, zero intermediary proxy overhead, and production-grade resilience.

---

## ✨ Key Features

- **🧠 Native Deep Reasoning:** Collapsible thinking blocks via VS Code `LanguageModelThinkingPart` and Copilot effort control (`None` to `Max`).
- **🛡️ Chained Multimodal Failover:** Automatic failover on 429/404/empty/timeout errors with a configurable model priority list (`fallback.priorityList`), routing text requests to Nemotron Lightning and image requests to MiniMax M3.
- **🔁 Repetition Loop Guard:** Detects degenerate "Let me fix..." output loops mid-stream and ends the turn cleanly instead of spinning forever.
- **🛠️ Self-Healing Tool Execution:** Streaming tag-stack XML scanner with auto-repair via `jsonrepair` and duplicate read loop prevention.
- **🗜️ Context Auto-Compaction:** Decoupled conversation history compaction with dedicated fast summarization models.
- **📊 Rich Telemetry:** Status bar token utilization widget, real prompt/completion token counts in Copilot Chat's context-window widget, and millisecond TTFT diagnostics.

---

## 🌟 Supported Models

The extension connects to official NVIDIA NIM endpoints (`https://integrate.api.nvidia.com/v1`) and provides model-specific prompt adapters:

| Model | Context Window | Reasoning Modes | Tool Calling | Vision | Best For |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **DeepSeek V4 Flash 0731** | 1M | `None`, `High`, `Max` | ✅ Yes | ❌ | Deep algorithm design, code architecture, complex refactoring |
| **Kimi K3** | 1M | `None`, `Low`, `High`, `Max` | ✅ Yes | ✅ Yes | Long-context multimodal comprehension, repository-scale work |
| **Nemotron 3.5 Lightning 30B** | 1M | `None`, `Medium`, `High`, `XHigh` | ✅ Yes | ❌ | Ultra-fast responses, agentic tool workflows, summarization |
| **Nemotron 3 Ultra 550B** | 1M | `None`, `Medium`, `High` | ✅ Yes | ❌ | Heavy multi-step reasoning, deep technical documentation |
| **MiniMax M3** | 1M | `None`, `On`, `Adaptive` | ✅ Yes | ✅ Yes | Multimodal code generation, full-stack tasks |
| **Step 3.7 Flash** | 262K | `Always On` | ✅ Yes | ✅ Yes | Rapid thinking loops, interactive pair programming |
| **Muse Glimmer** | 131K | `None` to `XHigh` | ✅ Yes | ✅ Yes | Visual UX/UI analysis and front-end generation |

---

## ⚙️ Documentation & Settings

For the complete reference of all `settings.json` options, failover policies, network parameters, and agentic tools, see our dedicated guide:

👉 [**📖 Full Documentation & Configuration Guide (docs/README.md)**](docs/README.md)

---

## ⚡ Quick Start

### 1. Install
- [Install from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent), or
- Quick Open (`Ctrl + P` / `Cmd + P`): `ext install neuraldock.nvidia-nim-agent`

### 2. Requirements
- **VS Code 1.125.0** or later
- **GitHub Copilot** extension installed and active
- **NVIDIA NIM API Key** (Get free credits at [build.nvidia.com](https://build.nvidia.com/models))

### 3. Configure Your API Key
1. Open Copilot Chat (`Ctrl + Alt + I` / `Cmd + Alt + I`).
2. Click the model selector dropdown $\rightarrow$ **Manage Models** $\rightarrow$ **NVIDIA NIM**.
3. Paste your NVIDIA NIM API key (`nvapi-...`).

*(Alternatively, run `NVIDIA NIM: Manage NVIDIA NIM API Key` from the Command Palette).*

### 4. Start Chatting & Coding
Select any NVIDIA NIM model in Copilot Chat or Copilot Agent Mode and start building!

---

## ⌨️ Extension Commands

Access these commands anytime from the VS Code Command Palette (`Ctrl + Shift + P` / `Cmd + Shift + P`):

| Command | Identifier | Description |
| :--- | :--- | :--- |
| **Manage API Key** | `nvidia-nim.manage` | Store or update your NVIDIA NIM API key in secure OS SecretStorage. |
| **Refresh Models** | `nvidia-nim.refreshModels` | Force re-sync available models and invalidate local cache. |
| **Toggle Debug Logging** | `nvidia-nim.toggleDebugLogging` | Quickly toggle verbose diagnostic logs on/off. |
| **Open Debug Log** | `nvidia-nim.openDebugLog` | Reveal the dedicated NVIDIA NIM Output Channel. |

---

## 🔒 Privacy & Security

- **Direct Communication:** Requests flow strictly between your VS Code client and the official NVIDIA NIM API (`https://integrate.api.nvidia.com/v1`). There are zero third-party telemetry servers or proxy gateways.
- **Secure Secret Storage:** API keys are encrypted and stored inside VS Code's native OS-level credential vault (`SecretStorage`).
- **No Data Retention by Extension:** The extension retains no chat logs, file contents, or personal credentials.

---

## ❓ Frequently Asked Questions

**Q: Do I need a paid NVIDIA subscription?**  
A: No. NVIDIA provides free API on [build.nvidia.com](https://build.nvidia.com/models) for developers.

**Q: Does it work with Copilot Agent Mode and Tools?**  
A: Yes! Supported chat models are tool-capable and support autonomous file editing, terminal execution, and MCP tools with automatic JSON repair.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
