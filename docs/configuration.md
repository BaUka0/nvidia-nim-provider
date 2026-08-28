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
  "nvidia-nim.tools.autoRepairArguments": true,
  "nvidia-nim.tools.suppressDuplicateReads": true,
  "nvidia-nim.context.autoCompactOnOverflow": true,
  "nvidia-nim.ui.showStatusBarItem": true
}
```

### Preset 2: Direct / No Failover (For Benchmarking)

Disables automatic backup routing so you can test specific models directly and inspect full diagnostic logs.

```json
{
  "nvidia-nim.fallback.enabled": false,
  "nvidia-nim.developer.debugLogging": true,
  "nvidia-nim.developer.logTimingBreakdowns": true
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
| `nvidia-nim.fallback.onRateLimit` | `true` | Automatically switch to backup if you reach rate limits (`HTTP 429` / `529`). |
| `nvidia-nim.fallback.onModelUnavailable` | `true` | Automatically switch to backup if a model is offline or decommissioned (`HTTP 404` / `410`). |
| `nvidia-nim.fallback.onEmptyStream` | `true` | Automatically switch to backup if a model returns an empty response. |
| `nvidia-nim.fallback.onTimeout` | `true` | Automatically switch to backup if a model stops responding mid-stream. |
| `nvidia-nim.fallback.firstTokenTimeoutSeconds` | `null` | Maximum seconds to wait for the model to start responding before switching to backup (5–120 seconds, or `null` to use stream timeout). |
| `nvidia-nim.fallback.showNoticeInChat` | `true` | Displays a short note at the top of the answer letting you know a backup model was used for that turn. |
| `nvidia-nim.fallback.notifyUser` | `true` | Shows a small notification popup in VS Code when failover occurs. |

---

### Reasoning & Thinking (`nvidia-nim.reasoning.*`)

Controls the thinking process for reasoning models (like DeepSeek V4, Nemotron Super, and Kimi K3).

| Setting | Default | Options | What it does |
| :--- | :--- | :--- | :--- |
| `nvidia-nim.reasoning.mode` | `none` | `none`, `on`, `medium`, `high`, `max` | Default reasoning depth for models that support configurable thinking effort. |
| `nvidia-nim.reasoning.showInChat` | `false` | `true`, `false` | When set to `true`, shows the internal thinking steps as regular text instead of a collapsible "Thinking..." block. |

---

### Long Conversations & History (`nvidia-nim.context.*`)

Keeps conversation history within the model's context window.

| Setting | Default | What it does |
| :--- | :--- | :--- |
| `nvidia-nim.context.autoCompactOnOverflow` | `true` | Automatically summarizes earlier messages in the background when a conversation gets too long, allowing you to keep chatting without errors. |
| `nvidia-nim.context.summarizationModel` | `nvidia/nemotron-3-super-120b-a12b` | The model used in the background to summarize older conversation history. |
| `nvidia-nim.context.safetyMarginPercent` | `1.0` | Percentage of the model's context window reserved as a safety buffer (0.0% to 10.0%) to prevent unexpected overflow errors. |

---

### Agent Mode & Tool Execution (`nvidia-nim.tools.*`)

Settings for file edits, terminal commands, and agent workflows.

| Setting | Default | What it does |
| :--- | :--- | :--- |
| `nvidia-nim.tools.autoRepairArguments` | `true` | Automatically fixes minor formatting and syntax mistakes in tool commands emitted by AI models. |
| `nvidia-nim.tools.autoRetryInvalidCalls` | `true` | Prompts the model to fix and retry its action if a command format is invalid, rather than crashing. |
| `nvidia-nim.tools.suppressDuplicateReads` | `true` | Prevents the AI agent from repeatedly reading the exact same file in a row. |

---

### Connection & Timeouts (`nvidia-nim.network.*`)

Timeout and retry settings for streaming and HTTP connections.

| Setting | Default | Range | What it does |
| :--- | :--- | :---: | :--- |
| `nvidia-nim.network.streamIdleTimeout` | `120` | `15`–`600` | How many seconds to wait between streaming chunks before considering the connection stalled. Increase this if you have a slow or high-latency connection. |
| `nvidia-nim.network.maxHttpRetries` | `3` | `0`–`10` | Number of automatic retries on temporary connection drops (e.g. network blips). |
| `nvidia-nim.network.maxEmptyStreamRetries` | `2` | `0`–`5` | Number of immediate retries if the server responds without emitting text chunks. |

---

### Response Tuning (`nvidia-nim.generation.*`)

Optional sampling parameters sent with each request.

| Setting | Default | Range | What it does |
| :--- | :--- | :---: | :--- |
| `nvidia-nim.generation.temperature` | `null` | `0.0`–`2.0` | Controls response creativity. Lower values (e.g. `0.2`) make answers more focused and deterministic; higher values (e.g. `0.8`) make them more creative. `null` uses the model default. |
| `nvidia-nim.generation.topP` | `null` | `0.0`–`1.0` | Alternative way to control response diversity. `null` uses the model default. |
| `nvidia-nim.generation.maxOutputTokens` | `null` | `≥128` | Maximum length of generated responses in tokens. `null` allows the full model capacity. |
| `nvidia-nim.generation.frequencyPenalty` | `null` | `-2`–`2` | Discourages the model from repeating words. `null` omits the parameter. |
| `nvidia-nim.generation.presencePenalty` | `null` | `-2`–`2` | Encourages the model to introduce new topics. `null` omits the parameter. |
| `nvidia-nim.generation.repetitionPenalty` | `null` | `0.5`–`2` | Specific penalty against repetitive phrasing. Values above `1.0` reduce repetition. |
| `nvidia-nim.generation.maxRepeatedLines` | `4` | `0`–`50` | Stops the response early if the model gets stuck repeating the same sentence. `0` disables loop detection. |
| `nvidia-nim.generation.autoContinueOnLoop` | `true` | — | Automatically prompts the model to continue working if it pauses mid-sentence or gets caught in a loop. |

---

### Status Bar & Diagnostics (`nvidia-nim.ui.*` & `nvidia-nim.developer.*`)

| Setting | Default | What it does |
| :--- | :--- | :--- |
| `nvidia-nim.ui.showStatusBarItem` | `true` | Shows real-time token utilization at the bottom of your VS Code window. |
| `nvidia-nim.developer.debugLogging` | `false` | Enables detailed logging in the VS Code Output panel for troubleshooting. |
| `nvidia-nim.developer.logTimingBreakdowns` | `true` | Records millisecond-level response speed metrics (TTFT and tokens-per-second) in debug logs. |

---

## Command Palette Shortcuts

Press `Ctrl + Shift + P` (or `Cmd + Shift + P` on macOS) to access quick extension actions:

- **`NVIDIA NIM: Manage NVIDIA NIM API Key`**: Add, update, or remove your API key.
- **`NVIDIA NIM: Refresh Available Models`**: Re-sync the available models list with NVIDIA servers.
- **`NVIDIA NIM: Toggle Debug Logging`**: Turn verbose debug logs on or off in one click.
- **`NVIDIA NIM: Open Debug Log`**: Open the dedicated NVIDIA NIM Output panel to view logs.
- **`NVIDIA NIM: Save Last Turn Report`**: Write the last few chat turns (redacted sampling/tool metadata) to a JSON file in Downloads.
