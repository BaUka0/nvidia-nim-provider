# Configuration Guide

How to customize the extension, adjust model behavior, and configure `settings.json`.

---

## How to Access Settings

You can adjust all settings in two ways:

1. **VS Code Settings UI**: Press `Ctrl + ,` (or `Cmd + ,` on macOS), then search for `NVIDIA NIM`.
2. **Directly in `settings.json`**: Press `Ctrl + Shift + P`, select `Preferences: Open User Settings (JSON)`, and add any of the configuration keys below.

---

## Quick Setup Presets

If you want a quick starting point, copy one of these configurations into your `settings.json`:

### Preset 1: Maximum Reliability (Recommended for Everyday Use)

Automatically switches to backup models during outages or rate limits, auto-repairs tool calls, and compresses long conversations in the background.

```json
{
  "nvidia-nim.fallback.enabled": true,
  "nvidia-nim.fallback.model": "nvidia/nemotron-3-super-120b-a12b",
  "nvidia-nim.fallback.visionModel": "meta/muse-glimmer-30b",
  "nvidia-nim.network.streamIdleTimeout": 120,
  "nvidia-nim.ui.showStatusBarItem": true
}
```

### Preset 2: Direct / No Failover (For Benchmarking)

Disables automatic backup routing so you can test specific models directly and inspect full diagnostic logs.

```json
{
  "nvidia-nim.fallback.enabled": false,
  "nvidia-nim.developer.debugLogging": true
}
```

---

## Settings Reference by Category

### Automatic Backup & Failover (`nvidia-nim.fallback.*`)

These settings control automatic re-routing when an NVIDIA NIM endpoint returns an error, hits a rate limit, or is offline.

| Setting | Default | What it does |
| :--- | :--- | :--- |
| `nvidia-nim.fallback.enabled` | `true` | When enabled, automatically re-routes your request to a backup model if the selected model encounters an error, so your chat is not interrupted. |
| `nvidia-nim.fallback.model` | `nvidia/nemotron-3-super-120b-a12b` | The backup model used for standard text prompts if your primary model fails. |
| `nvidia-nim.fallback.visionModel` | `meta/muse-glimmer-30b` | The backup model used when your prompt contains images or screenshots. |
| `nvidia-nim.fallback.priorityList` | `[]` | An optional list of specific models to try in order before falling back to the default backup model. |
| `nvidia-nim.fallback.onTimeout` | `true` | Automatically switch to backup if a model stops responding mid-stream. |
| `nvidia-nim.fallback.onFirstTokenTimeout` | `true` | Automatically switch to backup when the initial response / first token times out (long TTFT). If set to `false`, TTFT timeouts will not trigger failover. |
| `nvidia-nim.fallback.maxChainRestarts` | `2` | Extra full passes of the failover chain from the original model with backoff after every candidate fails with a transient error (timeouts, rate limits / overload 529, server errors) and no visible answer (`0`–`5`). `0` disables chain restarts. |
| `nvidia-nim.fallback.firstTokenTimeoutSeconds` | `null` | Maximum seconds to wait for the model to start responding before switching to backup (5–3600 seconds, or `null` to use stream timeout). |
| `nvidia-nim.fallback.showNoticeInChat` | `true` | Displays a short note at the top of the answer letting you know a backup model was used for that turn. |
| `nvidia-nim.fallback.notifyUser` | `true` | Shows a small notification popup in VS Code when failover occurs. |

---

### Reasoning & Thinking (`nvidia-nim.reasoning.*`)

Controls the thinking process for reasoning models (like DeepSeek V4, Nemotron Super, and Kimi K3).

| Setting | Default | Options | What it does |
| :--- | :--- | :--- | :--- |
| `nvidia-nim.reasoning.mode` | `none` | `none`, `on`, `medium`, `high`, `max` | Default reasoning depth for models that support configurable thinking effort. |

---

### Long Conversations & History (`nvidia-nim.context.*`)

Keeps conversation history within the model's context window.

| Setting | Default | What it does |
| :--- | :--- | :--- |
| `nvidia-nim.context.summarizationModel` | `nvidia/nemotron-3-super-120b-a12b` | The model used in the background to summarize older conversation history. |
| `nvidia-nim.context.safetyMarginPercent` | `1.0` | Percentage of the model's context window reserved as a safety buffer (0.0% to 10.0%) to prevent unexpected overflow errors. |

---

### Agent Mode & Tool Execution (`nvidia-nim.tools.*`)

Settings for file edits, terminal commands, and agent workflows.

| Setting | Default | What it does |
| :--- | :--- | :--- |
| `nvidia-nim.tools.maxConsecutiveIdenticalCalls` | `3` | Drops extra copies of the same tool call in one reply after this many identical calls. Already-emitted calls still run. `0` disables the cap. |

---

### Connection & Timeouts (`nvidia-nim.network.*`)

Timeout and retry settings for streaming and HTTP connections.

| Setting | Default | Range | What it does |
| :--- | :--- | :---: | :--- |
| `nvidia-nim.network.streamIdleTimeout` | `120` | `15`–`3600` | Maximum idle watchdog time in seconds between streamed chunks or tool calls before considering the connection stalled. Increase this for complex autonomous agent workflows. |
| `nvidia-nim.network.maxHttpRetries` | `3` | `0`–`10` | Number of automatic retries on temporary connection drops (e.g. network blips). |
| `nvidia-nim.network.maxEmptyStreamRetries` | `2` | `0`–`5` | Number of immediate retries if the server responds without emitting text chunks. |
| `nvidia-nim.network.maxTotalFetchAttempts` | `6` | `2`–`30` | Maximum cumulative HTTP fetch attempts across all retries, compact retries, and fallback model hops within a single Copilot turn. |

---

### Response Tuning (`nvidia-nim.generation.*`)

Optional sampling parameters sent with each request.

| Setting | Default | Range | What it does |
| :--- | :--- | :---: | :--- |
| `nvidia-nim.generation.temperature` | `null` | `0.0`–`2.0` | Controls response creativity. Lower values (e.g. `0.2`) make answers more focused and deterministic; higher values (e.g. `0.8`) make them more creative. `null` uses the model default. |
| `nvidia-nim.generation.topP` | `null` | `0.0`–`1.0` | Alternative way to control response diversity. `null` uses the model default. |
| `nvidia-nim.generation.maxOutputTokens` | `null` | `≥128` | Maximum length of generated responses in tokens. `null` allows the full model capacity. |
| `nvidia-nim.generation.maxRepeatedLines` | `4` | `0`–`50` | Stops the response early if the model gets stuck repeating the same sentence. A short section label can repeat across a report, and it only counts as a loop when that same label is printed again and again in a row. Reasoning also stops when the same paragraph comes back with different words, and a short phrase there can repeat a few more times. `0` disables loop detection. |
| `nvidia-nim.generation.maxLoopContinues` | `2` | `0`–`8` | How many times in one turn to nudge after a loop, hanging colon, truncated reply, repeated tool call, or stalled stream. `0` disables auto-continue. |

---

### Status Bar & Diagnostics (`nvidia-nim.ui.*` & `nvidia-nim.developer.*`)

| Setting | Default | What it does |
| :--- | :--- | :--- |
| `nvidia-nim.ui.showStatusBarItem` | `true` | Shows real-time token utilization at the bottom of your VS Code window. |
| `nvidia-nim.developer.debugLogging` | `false` | Technical debug logging in the Output panel (retries, budget, tool names, finish reasons). |
| `nvidia-nim.developer.logStreamChunks` | `false` | Include per-chunk SSE dumps in the debug log and saved session file. Leave off unless asked. |
| `nvidia-nim.developer.logUserMessages` | `false` | Include outgoing chat message bodies in the debug log and saved session file. Leave off unless asked. |

---

## Command Palette Shortcuts

Press `Ctrl + Shift + P` (or `Cmd + Shift + P` on macOS) to access quick extension actions:

- **`NVIDIA NIM: Manage NVIDIA NIM API Key`**: Add, update, or remove your API key.
- **`NVIDIA NIM: Refresh Available Models`**: Re-sync the available models list with NVIDIA servers.
- **`NVIDIA NIM: Toggle Debug Logging`**: Turn verbose debug logs on or off in one click.
- **`NVIDIA NIM: Open Debug Log`**: Open the dedicated NVIDIA NIM Output panel to view logs.
- **`NVIDIA NIM: Save Session Logs`**: Write recent turns plus the technical session log to a JSON file in Downloads. `NVIDIA NIM: Save Last Turn Report` is an alias for the same command.
