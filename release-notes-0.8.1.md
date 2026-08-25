# v0.8.1 — Fix for NIM sampling penalty validation & model catalog cleanup

This patch release fixes an `HTTP 400 Bad Request` validation error caused by immutable sampling penalties on certain NVIDIA NIM models (such as Kimi K3), ensures clean opt-in penalty parameters, and cleans up the active curated catalog.

## Fixed: HTTP 400 `presence_penalty is immutable` on NVIDIA NIM

* **Root Cause Fixed:** In v0.8.0, certain low-temperature heuristics automatically applied `presence_penalty` / `frequency_penalty` fields to outgoing requests. On backend inference engines (like TensorRT-LLM on NVIDIA NIM), models such as `moonshotai/kimi-k3` strictly require `presence_penalty` to be 0 or omitted entirely, causing requests to be rejected with `HTTP 400: Validation: presence_penalty is immutable for this model and must be 0`.
* **Clean Parameter Forwarding:** Unconfigured penalties are now completely omitted from API payloads by default (`null`).
* **Immunity Guard for Kimi K3:** `KimiAdapter` is now guarded at the adapter level against unsupported penalty parameters. Even if a user explicitly configures `nvidia-nim.generation.presencePenalty` or `frequencyPenalty` globally in VS Code settings, the extension automatically suppresses those unsupported keys for Kimi K3, preventing request failures while still allowing supported parameters like `repetitionPenalty`.

## Catalog Cleanup

* **Sunsetted Model De-listing:** Removed `thinkingmachines/inkling` from the active catalog and fallback pickers following its deprecation (`HTTP 410 Gone`) on official NVIDIA NIM endpoints. Full adapter infrastructure is preserved to support future successor models without delay.

## Anti-Loop Architecture

* The 4-layer anti-loop protection (streaming `RepetitionGuard` with markdown code-fence awareness, inter-turn history loop detection, and `autoContinueOnLoop` nudging) remains fully active and working out-of-the-box without requiring parameter overrides.

## Install / Update

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent), update via the Extensions view in VS Code, or install from `nvidia-nim-agent-0.8.1.vsix`.
