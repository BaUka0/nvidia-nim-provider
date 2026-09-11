# v0.10.3 — Keep Agent Mode going on loops

This release undoes the abrupt stop introduced in 0.10.2. If a model gets stuck repeating itself, hanging on a trailing colon, or calling the same tool, the extension nudges it to keep working instead of aborting the Copilot turn or hopping to the backup model.

## What changed for you

* **Loops no longer kill the turn.** Extra identical tool calls in one reply are still dropped. Tools that already went out still run, so the agent can continue. Across turns, a stuck preamble gets a warning, then one stronger follow-up if it is still looping.
* **Planning loops with line breaks are caught.** A Super 120B-style cycle such as "we'll re-read the file" no longer finishes as a normal answer. The stream is cut and the model is nudged to take a real next step.
* **You can tune the budgets.** `nvidia-nim.generation.maxLoopContinues` (default 2) is how many nudges happen in one turn. `nvidia-nim.tools.maxConsecutiveIdenticalCalls` (default 3) is how many identical tool calls in one reply are allowed before extras are dropped. Both are in the Settings UI and `settings.json`.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.10.3.vsix` package.
