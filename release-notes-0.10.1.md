# v0.10.1 — Sampling calibration and error visibility

This release aligns model sampling defaults with official NVIDIA NIM recommendations to prevent repetitive preamble loops during tool calling. It also preserves original service error details during rate limits and improves multi-turn chat stability.

## What changed for you

* **Sampling parameters.** Models in the catalog now use standard sampling defaults (temperature 1.0 and top-p 0.95) recommended by NVIDIA. This prevents repetitive preamble loops before tool calls caused by greedy decoding.
* **Service error visibility.** If requests hit rate limits or temporary server overload after retries, Copilot Chat shows the actual error message from NVIDIA instead of a generic HTTP status code.
* **Chats with images.** Summarizing long conversation history that contains images now extracts and compacts the text cleanly instead of including raw data structures.
* **Concurrent tool calls.** When the API returns multiple tool calls in a single stream without explicit call indices, both calls are captured and executed without collisions.
* **Model list refreshing.** If a catalog refresh temporarily returns an empty response, the extension re-queries on the next request rather than caching an empty model picker.
* **Reasoning mode warnings.** If a configured reasoning mode is not supported by the selected model, reasoning is turned off for that request and a diagnostic note is logged to the Output channel.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.10.1.vsix` package.
