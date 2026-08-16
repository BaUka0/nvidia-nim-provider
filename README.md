# NVIDIA NIM Agent

VS Code extension that gives you access **exclusively** to the best, most powerful reasoning and agentic models available in NVIDIA NIM (DeepSeek, Kimi, GLM, Nemotron, MiniMax, Stepfun, Inkling, Muse Glimmer) directly inside the Copilot Chat interface.

## Requirements

- VS Code 1.125.0 or later
- GitHub Copilot extension installed and active
- An NVIDIA NIM API key from [build.nvidia.com/models](https://build.nvidia.com/models)

## Installation

### From Source

1. Clone this repository.
2. Run `npm install && npm run compile`.
3. Press `F5` in VS Code to launch the Extension Development Host.

### From VSIX

1. Run `npm install && npm run package:vsix`.
2. Install the generated `.vsix` file via the Extensions view (`Install from VSIX...`).

## Setup

1. Open Copilot Chat and choose the model picker.
2. Select **Manage Models**, then add/configure **NVIDIA NIM**.
3. Paste the API key obtained from [build.nvidia.com/models](https://build.nvidia.com/models).
4. Select one of the NVIDIA NIM models returned by your account.

You can also run `NVIDIA NIM: Manage NVIDIA NIM API Key` from the Command Palette. The extension
will migrate that key into VS Code's language model provider group so the model picker can resolve
NVIDIA NIM models. The VS Code model settings flow is recommended for new setups.

## Supported Models

The extension fetches the model list from `https://integrate.api.nvidia.com/v1/models` and
filters it down to a curated set of elite agentic models. Model-specific adapters tune temperature,
tool-calling system prompts, and reasoning configuration where required:

| Model                      | Reasoning Modes                              | Tool Calling | Vision |
| -------------------------- | -------------------------------------------- | ------------ | ------ |
| DeepSeek V4 Flash 0731     | None, High, Max                              | Yes          | No     |
| Nemotron 3 Ultra 550B      | None, Medium, High                           | Yes          | No     |
| Nemotron 3.5 Lightning 30B | None, Medium, High, XHigh                    | Yes          | No     |
| Kimi K2.6                  | None, On                                     | Yes          | Yes    |
| MiniMax M3                 | None, On, Adaptive                           | Yes          | Yes    |
| GLM 5.2                    | None, On                                     | Yes          | No     |
| Step 3.7 Flash             | Always on                                    | Yes          | Yes    |
| Inkling                    | None, Minimal, Low, Medium, High, XHigh, Max | Yes          | Yes    |
| Muse Glimmer               | None, Low, Medium, High, XHigh               | Yes          | Yes    |

When NVIDIA's `/models` response omits tool-calling capability metadata, chat models are treated as
tool-capable so they remain selectable in Copilot Chat Agent mode.

## Reasoning

The extension supports native reasoning token rendering via VS Code's proposed
`LanguageModelThinkingPart` API. When a model emits reasoning — either through the
`reasoning_content` stream field or inline `think... /think` tags (used by Kimi) — it is
captured and rendered as collapsible thinking blocks in the chat interface instead of being
dumped as raw text.

Configure reasoning effort per model via the **Copilot Chat model picker dropdown**. Each model
exposes its supported reasoning modes (see the table above). The selected mode is sent to the
NVIDIA NIM API using the appropriate parameters (`reasoning_effort`, `enable_thinking`, or
`chat_template_kwargs` depending on the model).

### Settings

- `nvidia-nim.reasoningMode` — Default reasoning effort when a model doesn't explicitly pass a
  mode via the dropdown. Defaults to `none`.
- `nvidia-nim.showReasoning` — Show reasoning content as plain text in responses (fallback for
  VS Code versions without `LanguageModelThinkingPart` support, or for debugging). Defaults to
  `false`.

## Commands

| Command                                        | Description                              |
| ---------------------------------------------- | ---------------------------------------- |
| `NVIDIA NIM: Manage NVIDIA NIM API Key`        | Configure or update the API key.         |
| `NVIDIA NIM: Refresh Models`                   | Re-fetch the model list from NVIDIA NIM. |
| `NVIDIA NIM: Toggle Reasoning Content Display` | Toggle `showReasoning` at runtime.       |
| `NVIDIA NIM: Toggle Debug Logging`             | Enable/disable verbose debug output.     |
| `NVIDIA NIM: Open Debug Log`                   | Open the debug log output channel.       |

## Usage

1. Open Copilot Chat (`Cmd/Ctrl + Alt + I`).
2. Select **NVIDIA NIM** from the provider selector.
3. Choose one of the curated NVIDIA NIM models.
4. (Optional) Use the model dropdown to set the reasoning effort.
5. Start chatting — reasoning appears as collapsible thinking blocks, tool calls are emitted
   natively, and text-embedded tool-call markers are parsed automatically.

## Development

```bash
npm install
npm run compile
npm run lint
npm run test
```

Press `F5` in VS Code to launch the Extension Development Host.

### Available Scripts

- `npm run compile` – TypeScript compilation
- `npm run watch` – Compile with file watching
- `npm run test` – Run tests
- `npm run lint` – ESLint check
- `npm run lint:fix` – ESLint auto-fix
- `npm run format` – Prettier formatting
- `npm run package:vsix` – Build VSIX package

## NVIDIA API Diagnostics

The public model-list endpoint can be checked without an API key:

```bash
npm run probe:models
```

Context probes require `NIM_API_KEY` (also accepts `NVIDIA_API_KEY`, `NVIDIA_NIM_API_KEY`, or
`NGC_API_KEY`) and a model ID passed as the final argument or through
`NVIDIA_NIM_MODEL`. Each probe performs two small calibration requests and one large request with
`max_tokens: 1`. Large probes consume billable input tokens.

```bash
npm run probe:context:262k -- moonshotai/kimi-k2.6
npm run probe:context:500k -- thinkingmachines/inkling
npm run probe:context:1048k -- deepseek-ai/deepseek-v4-flash-0731
```

Set `NVIDIA_NIM_BASE_URL` to test a compatible endpoint other than
`https://integrate.api.nvidia.com/v1`. A context rejection exits with status `2` and prints the
maximum and actual token counts parsed from the NVIDIA error response.
Transient `429` and `5xx` responses are retried with bounded exponential backoff. Set
`NVIDIA_NIM_PROBE_RETRIES` to change the default of four retries.

## Marketplace Packaging

```bash
npm run package:vsix
```

The command above produces a `.vsix` that can be uploaded in the VS Code Marketplace publisher portal.

## Privacy

- Your API key is stored securely through VS Code's language model provider configuration and, for
  legacy command-palette setup, VS Code SecretStorage.
- Chat completions and model discovery requests are sent to `https://integrate.api.nvidia.com/v1`.
