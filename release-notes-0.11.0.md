# v0.11.0 — GLM 5.3 Flash Model Addition

This release adds GLM 5.3 Flash (`z-ai/glm-5.3-flash`) to the curated model catalog, providing a fast, long-context reasoning model with full image understanding and tool calling capabilities for Copilot Chat.

## What changed for you

* **GLM 5.3 Flash in the model picker.** You can now choose GLM 5.3 Flash (`z-ai/glm-5.3-flash`) directly from the Copilot Chat model picker or configure it as a fallback and history summarization model.
* **1M context and vision support.** The model provides a 1,048,576 token context window with up to 131,072 output tokens, accepts image inputs for multimodal tasks, and supports native tool execution in Agent Mode.
* **Configurable reasoning modes.** Choose between `Low`, `High`, and `Max` reasoning effort in the model options dropdown. Setting the mode to `Low` bypasses the thinking delay for instant answers, while `High` and `Max` provide deeper step-by-step reasoning for complex tasks.
* **Reliable long-form answers.** Repetition and frequency penalties are ignored for GLM to prevent language degradation and associative drift on extensive code reviews and detailed responses.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.11.0.vsix` package.
