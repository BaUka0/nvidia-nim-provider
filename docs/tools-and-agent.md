# Tool Execution & Agent Mode

Details on tool calling, streaming XML parsers, argument auto-repair, and multimodal image analysis.

---

## How Copilot Agent Mode Edits Files & Runs Commands

In Copilot Agent Mode, the model emits tool requests to read files, write edits, search the workspace, or run terminal commands. Different models emit different formats:

- Standard OpenAI JSON (`tool_calls`).
- XML control blocks (e.g. `<tool_call><function=run_in_terminal>…</tool_call>`).
- Hermes or Anthropic-style tags.

---

## Tag-Stack XML Streaming Parser

The extension includes a single-pass streaming parser (`src/tools/xml-tool-scanner.ts`) that handles all of these formats without waiting for the full response. If a model writes an example `<tool_call>` inside a markdown code fence (` ```xml `), the parser leaves it as plain text rather than treating it as a real command.

---

## Automatic JSON Repair & Retries

Models often emit slightly malformed JSON (missing braces, unescaped quotes inside code snippets, trailing commas). The extension runs broken tool arguments through `jsonrepair` to fix syntax errors, then resolves parameter aliases (e.g. `path`, `targetFile`, `file` to `filePath` for read tools). If the result is still invalid, the extension sends a structured correction back to the model as an internal retry turn instead of crashing the request.

---

## Loop Prevention

Autonomous agents can get stuck re-reading the same file. The extension tracks read-only operations and suppresses identical consecutive calls. Write operations and terminal execution (e.g. re-running a failed build) are never blocked. If the same validated tool call is emitted `nvidia-nim.tools.maxConsecutiveIdenticalCalls` times in one reply (default `3`), extra copies are dropped; tools that already went out still run so the agent can keep working.

Repetition guards monitor the answer and the thinking stream separately. In the answer, the same line repeating `maxRepeatedLines` times (default `4`), a stuck preamble such as several lines opening with "Let me", or a passage of about a dozen words repeating in the recent text cuts the loop and nudges the model to continue (`nvidia-nim.generation.maxLoopContinues`, default `2` times in the same turn). Thinking may reuse ordinary sentence openings ("We'll", "Let's", "We need"); it is cut only when the same line or a longer passage actually repeats. Across turns, a stuck preamble or repeated tool call gets one breaker injected into the next request. The turn is not aborted and does not hop to the backup model for a loop, including when the continue budget runs out before any answer is produced.

---

## Image Analysis Tool

The extension registers a native language model tool for Copilot Chat:

### `nvidia_nim_analyze_image`

- **Purpose:** Multimodal tool that allows Copilot Agent to inspect and analyze visual images.
- **Trigger:** Drag-and-drop a screenshot, UI mockup, or diagram into Copilot Chat.
- **Parameters:**
  - `prompt` (`string`): The user's query or instruction describing what to extract from the image.
  - `image_data` (`string`): Base64-encoded `data:image/...` URL.
