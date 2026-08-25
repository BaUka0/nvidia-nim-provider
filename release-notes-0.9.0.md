# v0.9.0 — NVIDIA Nemotron 3 Super 120B & Tool Calling Reliability Improvements

This update adds the NVIDIA Nemotron 3 Super 120B model and brings fixes for file inspection and tool calling reliability in Copilot Chat.

## NVIDIA Nemotron 3 Super 120B

* **Workhorse Model for Everyday Work:** Added `nvidia/nemotron-3-super-120b-a12b`, a fast and capable reasoning model tailored for everyday coding, refactoring, and agentic tasks.
* **Context Window:** 1,000,000-token context window for working with large files and broad project context.
* **Reasoning Modes:** Supports `none`, `low`, and `high` reasoning effort settings.
* **Model Picker:** Available immediately in the VS Code model picker dropdown and supported in fallback and summarization settings.

## Tool Calling & File Inspection Reliability

* **Fixed Cross-File Line Overlaps:** Resolved an issue where active text selections in an open editor were unintentionally applied when reading other files in the workspace. File-reading tools now start cleanly from the beginning of the target file.
* **Accurate Code Edits:** Line selections are now strictly scoped to the active open file being edited, preventing edits from misaligning across files.
* **Broader MCP Tool Compatibility:** Added support for various parameter naming styles (camelCase, snake_case, PascalCase), allowing custom and third-party MCP tools to work smoothly out of the box.
* **Better Error Recovery:** If a tool call repeats or encounters a temporary formatting issue, the assistant now provides corrective feedback and continues the conversation rather than ending early.

## Install / Update

Install from the Visual Studio Marketplace, update directly through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.9.0.vsix` package.
