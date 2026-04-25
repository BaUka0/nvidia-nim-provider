# Change Log

## [0.1.11] - 2026-04-26

### Fixed

- Suppress duplicate model picker entries when multiple configured NVIDIA NIM provider groups use
  the same API key.

## [0.1.10] - 2026-04-25

### Fixed

- Avoid duplicate NVIDIA NIM model picker entries by only returning models for VS Code provider
  groups that supply an API key configuration.
- Keep legacy API keys available for migration and chat fallback without advertising a second
  unconfigured copy of every model.

## [0.1.9] - 2026-04-25

### Fixed

- Mark NVIDIA NIM models as user-selectable so Copilot Chat's model picker does not filter them out.
- Treat missing NVIDIA `/models` tool-calling metadata as unknown/supported instead of unsupported, so
  chat models are still available when Copilot Chat is in Agent mode.
- Refresh stale normalized model caches when VS Code model settings provide an API key, ensuring older
  caches written before this picker metadata fix are upgraded.

## [0.1.8] - 2026-04-25

### Fixed

- Automatically migrate API keys saved by the legacy `NVIDIA NIM: Manage NVIDIA NIM API Key`
  command into VS Code's language model provider group, so Copilot Chat's model picker resolves
  NVIDIA NIM models instead of only showing the provider in settings.
- Keep the legacy SecretStorage key as a fallback while wiring it into VS Code's model configuration
  flow.

## [0.1.7] - 2026-04-25

### Fixed

- Add the VS Code language model provider configuration schema for the NVIDIA NIM API key.
- Read API keys supplied by VS Code model settings when resolving picker models and chat requests.
- Remove the deprecated model provider `managementCommand` contribution so VS Code can create a
  configured NVIDIA NIM model group.

## [0.1.6] - 2026-04-25

### Fixed

- Fetch NVIDIA NIM models on demand when the Copilot Chat model picker asks for models before the
  background refresh has populated the cache.

## [0.1.5] - 2026-04-25

### Fixed

- Clear stale cached models when NVIDIA NIM `/models` successfully returns an empty list.
- Treat non-array persisted model cache values as malformed and return no picker models.
- Update image-analysis helper comments to reflect cached vision-model selection rather than fallback behavior.

## [0.1.4] - 2026-04-25

### Fixed

- Removed the copied OpenCode Go fallback model catalog. The model picker now relies on models
  discovered from NVIDIA NIM `/models` and returns no models until a normalized NVIDIA model cache
  exists.
- Updated README and Marketplace metadata so the extension no longer advertises copied OpenCode Go
  model names.

## [0.1.3] - 2026-04-25

### Added

- NVIDIA NIM Copilot Chat provider.
- Dynamic model discovery from `https://integrate.api.nvidia.com/v1/models`.
- OpenAI-compatible streaming chat completions through NVIDIA NIM.
- Tool calling and vision capability gating based on normalized NVIDIA model metadata.
- Secure NVIDIA API key storage via VS Code SecretStorage.
- Commands for managing the API key, refreshing models, and opening debug logs.

### Changed

- Project was rebranded from the reference implementation to NVIDIA NIM.
