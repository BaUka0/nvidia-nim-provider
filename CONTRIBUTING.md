# Contributing Guidelines

Guidelines for reporting issues, contributing code, and maintaining NVIDIA NIM Agent.

---

## Project Status

The extension's core feature set is complete:
* Streaming chat and live reasoning integration
* Multi-model failover chains and restart recovery
* Repetition detection and loop breaking
* Context compaction and token usage accounting
* Tool calling argument repair and validation

Development is focused on stability, bug fixes, model catalog updates from upstream NVIDIA NIM, and compatibility with new VS Code releases.

---

## Reporting Issues

Use the [GitHub Bug Report form](https://github.com/BaUka0/nvidia-nim-provider/issues/new?template=bug_report.yml) to submit issues.

Include the following to ensure issues can be investigated without unnecessary round-trips:
* **Active Model & Reasoning Mode:** Model ID and reasoning level in use when the issue occurred.
* **Diagnostic Logs:**
  * **Session Log** (`Ctrl+Shift+P` / `Cmd+Shift+P` → `NVIDIA NIM: Save Session Logs`): For network timeouts, HTTP 429/503/529 errors, failover failures, or tool execution issues.
  * **Last Turn Report** (`Ctrl+Shift+P` / `Cmd+Shift+P` → `NVIDIA NIM: Save Last Turn Report`): For repetition loops, truncated output, or abnormal model responses.

API keys and authorization tokens are automatically redacted by the diagnostic commands.

---

## Feature & Model Requests

To propose a new NVIDIA NIM model or configuration option, submit a [Feature or Model Request](https://github.com/BaUka0/nvidia-nim-provider/issues/new?template=feature_or_model_request.yml) with:
* Upstream model ID from [build.nvidia.com/models](https://build.nvidia.com/models)
* Context window and max output limits
* Supported capabilities (tools, vision, reasoning)

Pull requests adding verified model entries or adapters are welcome.

---

## Local Development

### Prerequisites

* [Node.js](https://nodejs.org/) (v20 or v22+)
* [npm](https://www.npmjs.com/)
* [VS Code](https://code.visualstudio.com/) (v1.125.0+)

### Setup

```bash
git clone https://github.com/BaUka0/nvidia-nim-provider.git
cd nvidia-nim-provider
npm install
npm run compile
```

### Verification

All checks must pass before opening a pull request:

```bash
# Run unit test suite
npm test

# Run ESLint
npm run lint

# Check code formatting
npm run format

# Strict type check
npm exec -- tsc --noEmit
```

### Pull Request Guidelines

1. Add unit or regression tests under `tests/` for all bug fixes and new behavior.
2. Keep changes focused. Avoid mixing refactorings or cosmetic edits into bug fix PRs.
3. Respect architectural boundaries (`src/api/`, `src/messages/`, `src/models/`, `src/provider/`, `src/shared/`, `src/tools/`).

---

## Support

If you find this project useful, you can support ongoing maintenance on [Ko-fi](https://ko-fi.com/baurzhanbissanov).
