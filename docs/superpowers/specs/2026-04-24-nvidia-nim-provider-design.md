---
title: NVIDIA NIM Provider Design
date: 2026-04-24
tags:
  - design
  - vscode
  - copilot-chat
  - nvidia
  - nim
summary: Approved design for a new VS Code Copilot Chat provider that uses NVIDIA-hosted NIM OpenAI-compatible APIs and dynamic model discovery.
---

## Context

Create a new project folder named `nvidia-nim-provider` based on the structure and behavior of
`opencode-go-provider`, then adapt it so GitHub Copilot Chat can use NVIDIA-hosted models through
`https://integrate.api.nvidia.com/v1`.

The project should preserve the proven extension shape from the reference project while reducing
provider-specific branching. The first release should favor correctness and clear boundaries over
aggressive abstraction.

## Goals

- Create a standalone VS Code extension project for GitHub Copilot Chat.
- Use NVIDIA-hosted NIM with `Authorization: Bearer <API_KEY>`.
- Source models dynamically from `GET /models`.
- Send chat requests through `POST /chat/completions`.
- Support streaming responses and tool calling where the selected model supports them.
- Keep the implementation close enough to `opencode-go-provider` that tests and maintenance stay
  straightforward.

## Non-goals

- No multi-provider shared core in the first release.
- No Anthropic-format request path.
- No MCP-based image fallback or OCR-style substitute path.
- No hardcoded fallback model catalog for the initial version.

## Chosen Approach

The project will use a thin-fork approach:

- Copy the reference extension shape into a new `nvidia-nim-provider` project.
- Rename branding, commands, storage keys, and API integration points for NVIDIA.
- Introduce a dedicated model normalization layer so NVIDIA-specific capability decisions stay
  isolated from the VS Code provider logic.

This keeps the initial delivery small and reliable while leaving room to extract shared code later
if multiple providers need to coexist.

## Project Structure

The project will start with this responsibility split:

| Path | Responsibility |
| --- | --- |
| `src/extension.ts` | Register the Copilot Chat provider, manage API key commands, trigger model refresh, and manage logging |
| `src/provider.ts` | Bridge VS Code chat requests and responses to the NVIDIA API, including streaming and tool-call emission |
| `src/api.ts` | Call `GET /models` and `POST /chat/completions`, handle retries, and parse SSE responses |
| `src/model-catalog.ts` | Normalize `/models` output into `LanguageModelChatInformation` and infer capabilities safely |
| `src/types.ts` | Define OpenAI-compatible request and response types plus NVIDIA model list response types |
| `tests/` | Validate API behavior, model normalization, provider behavior, and extension wiring |

The design intentionally avoids a large shared abstraction layer. NVIDIA-specific heuristics belong
in `model-catalog.ts`, not in `provider.ts`.

## Model Discovery and Normalization

`GET /models` is the single source of truth for the initial release.

### Refresh behavior

- On activation, if an API key exists, the extension refreshes models in the background.
- A manual `Refresh Models` command triggers the same flow on demand.
- Successful refreshes store both the raw model list and the normalized list in `globalState`.
- The chat UI returns cached normalized models immediately so the picker never blocks on network I/O.
- If no API key or no cache exists yet, the provider returns an empty model list and relies on the
  command and chat guidance to drive setup.

### Normalization rules

`model-catalog.ts` should apply capability resolution in this order:

1. Use explicit capability or metadata fields returned by `/models` when available.
2. Apply a small `KNOWN_MODEL_OVERRIDES` table for popular NVIDIA model IDs that need precise
   metadata.
3. Fall back to safe defaults when information is missing.

### Safe defaults

When `/models` does not provide enough information:

- `toolCalling = false`
- `imageInput = false`
- conservative token limits are used
- display names are derived from the raw model ID

This design prefers under-promising over surfacing features that fail at runtime.

### Model filtering

The extension should only exclude models that are clearly not for chat use.

- If a capability flag such as `chat === true` exists, use it directly.
- If capability metadata is absent, apply light ID-based filtering for obvious non-chat entries such
  as embedding or reranking models.
- Otherwise keep the model visible so `/models` remains the primary source of truth.

## Request and Response Path

The first release uses a single OpenAI-compatible path:

- Endpoint: `POST /chat/completions`
- Auth: `Authorization: Bearer <API_KEY>`
- Streaming: OpenAI-compatible server-sent events

### Request handling

- Convert VS Code chat messages to OpenAI-compatible `messages`.
- Forward `tools` and `tool_choice` only when the selected model is marked as tool-call capable.
- Pass image input only when the selected model is marked as image-capable.
- Do not silently substitute another model or another transport when a capability is unsupported.

### Unsupported capability behavior

If the user selects a model that does not support the requested capability:

- return a clear Copilot Chat message explaining the limitation
- suggest choosing another NVIDIA model
- avoid hidden fallbacks that change model behavior unexpectedly

## Error Handling

The extension should follow the same user-facing error philosophy as the reference project:

- `401` or `403`: prompt the user to update the NVIDIA API key
- `429`: explain that the request was rate-limited
- `5xx`: explain that NVIDIA may be experiencing a temporary issue
- refresh failures should not break the picker if cached models already exist

Retry behavior belongs in `src/api.ts` and should cover transient failures without retrying clearly
invalid requests.

## Testing Strategy

The initial test suite should cover four areas:

| Test file | Coverage |
| --- | --- |
| `tests/api.test.ts` | `/models` fetching, `/chat/completions` streaming, auth errors, retryable failures |
| `tests/model-catalog.test.ts` | normalization, capability inference, model filtering, default metadata |
| `tests/provider.test.ts` | missing API key guidance, streaming output, tool-call handling, capability gating |
| `tests/extension.test.ts` | command registration, secret updates, refresh behavior, provider notifications |

## Implementation Order

1. Create `nvidia-nim-provider` from the reference project with minimal renaming.
2. Update `package.json`, README, command IDs, labels, and secret storage keys for NVIDIA.
3. Replace provider constants and API wiring for `https://integrate.api.nvidia.com/v1`.
4. Add `src/model-catalog.ts` and move model normalization there.
5. Simplify `src/provider.ts` to a single OpenAI-compatible request path.
6. Update tests, then run compile, lint, and test commands.

## Scope Guardrails

The first release should stay focused on enabling NVIDIA models in Copilot Chat with a dependable
baseline experience. The following can be considered later, but are intentionally out of scope now:

- deeper per-model metadata enrichment
- model-specific prompt tuning
- shared provider infrastructure
- advanced image fallback paths
- additional NVIDIA endpoint families beyond `/models` and `/chat/completions`

## Outcome

After implementation, the new project should provide a standalone NVIDIA-branded Copilot Chat
extension that:

- authenticates with an NVIDIA API key
- shows models discovered from `/models`
- sends chat requests to NVIDIA-hosted NIM
- streams responses into Copilot Chat
- enables capabilities only when the selected model can support them
