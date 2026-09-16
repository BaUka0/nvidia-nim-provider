# v1.0.1 — API Key Resolution and Multi-Turn Stability Hotfix

This stability update fixes intermittent API key configuration errors during background Copilot agent turns and preserves credential bindings across automatic model failovers.

## What changed for you

* **Reliable background agent turns.** Fixed intermittent "NVIDIA NIM API key is not configured" errors that could occur during multi-turn agent sessions. Background model queries from VS Code no longer cause the extension to temporarily lose track of your active API key.
* **Resilient fallback authentication.** When a primary model encounters rate limits or connection errors, automatic failovers to backup models now reliably retain your active API key credentials.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.0.1.vsix` package.
