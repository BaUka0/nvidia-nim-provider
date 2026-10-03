# v1.4.0 — Nemotron 3 Super Retirement, Task-Wide Loop Guard, and Tool Call Self-Healing

This minor release replaces Nemotron 3 Super 120B, which NVIDIA retired on October 3, 2026, with Nemotron 3.5 Lightning 30B as the default backup and summarization model. It also lets long agent sessions recover from broken or repeated tool calls instead of failing the request.

## What changed for you

* **Nemotron 3 Super 120B is retired.** NVIDIA shut the model down on October 3, 2026, and it now rejects every request, so it is no longer offered. Nemotron 3.5 Lightning 30B takes its place as the default backup model and as the model that summarizes older conversation history. Lightning is a compact, fast model with a 1M-token context window and `None`, `Medium`, `High`, and `XHigh` reasoning modes, available in the model picker. If you had chosen Nemotron 3 Super for either setting, the extension switches to Lightning on its own.
* **Retired models are skipped for the rest of the session.** When NVIDIA reports that a model has been retired, the extension remembers it until VS Code restarts. Later steps go straight to the backup model without calling the retired one, the fallback notice appears once instead of on every step, and the model disappears from the model picker.
* **Edits no longer fail over a missing description.** Long conversations sometimes make a model drop the short description that edit tools expect. The extension now fills in a neutral description and lets the edit run, instead of ending the turn with "your request failed".
* **Tool mistakes are corrected inside the task.** When a tool call still arrives with a missing or malformed argument, it is passed to the tool, which explains exactly what is wrong, and the model fixes the call in the next step. Before, the extension retried the whole turn on its own and could run through every model in the fallback chain.
* **One limit for repeated tool calls.** Reading the same file again now simply works. The same call with the same arguments can run up to 4 times in a task; the next copy is dropped as a loop and the model is asked to move on. The count resets when the model uses a different tool or you send a new message. Change or turn off the limit with `nvidia-nim.tools.maxConsecutiveIdenticalCalls` in the VS Code Settings UI or `settings.json`; a value of N now allows exactly N identical calls. If the model keeps repeating the call anyway, the chat says so instead of ending with an empty reply.
* **Cut-off edits are not applied.** If the connection drops, the stream stalls, or the reply hits the output limit while a tool call is still being written, the half-finished call is not run. The model is asked to send it again, so a partial edit can no longer land in your files.
* **Replies that only think get one more chance.** When a model finishes thinking but writes no answer and calls no tool, the extension asks the same model once to act on its reasoning before moving the turn to another model.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.4.0.vsix` package.
