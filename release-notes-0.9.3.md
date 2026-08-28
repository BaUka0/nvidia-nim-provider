# v0.9.3 — Turn report for stuck chats

This release makes it easy to capture what the last chat turn actually did, so looping or hung replies can be diagnosed without turning on verbose debug logging first.

## What changed for you

* **Save Last Turn Report.** After a bad turn, open the Command Palette and run **NVIDIA NIM: Save Last Turn Report**. A small JSON file is written to your Downloads folder. Attach that file to a GitHub issue. Debug logging does not need to be on beforehand. If Downloads is not writable, VS Code asks where to save instead.
* **Missing API key fails honestly.** If no key is configured, the turn fails with a permissions error instead of looking like a successful empty answer. Clearing the stored key also refreshes the model cache.
* **Clearer cut-offs.** When the model hits its output token limit, the extension continues once or shows a short notice. If NVIDIA filters the reply, you get a notice instead of a silent stop. Turns that end on a trailing colon (next action expected, no tool call) still auto-continue.
* **Safer failover.** Network errors can fail over to the backup model. If the configured text backup is missing or marked unavailable, the extension picks another available model. Thinking-only streams no longer splice two models into one reply.
* **Image size cap.** Oversized in-chat images are rejected with a clear error instead of being dropped.

## Also in this build

* User docs are split into separate guides (getting started, models, failover, tools, context, configuration, troubleshooting).
* Coverage reports are no longer packed into the VSIX.
* Vision analysis uses the configured vision fallback model when it is already cached.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.9.3.vsix` package.
