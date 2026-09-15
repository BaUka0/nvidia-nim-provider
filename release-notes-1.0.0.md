# v1.0.0 — GLM 5.3 Reasoning, Extended Timeout Recovery, and Streamlined Settings

This landmark release adds the GLM 5.3 flagship reasoning model, introduces automatic failover chain restarts and longer timeout boundaries for heavy reasoning workloads, prevents mid-stream stalls from killing agent turns, and streamlines configuration by removing obsolete and redundant settings.

## What changed for you

* **GLM 5.3 reasoning model.** Added GLM 5.3 to the curated catalog and model picker. Features a 1,048,576 token context window, 65,536 maximum output tokens, native tool calling, and selectable reasoning modes (`Low`, `High`, `Max`), with `Low` providing immediate answers without reasoning latency.
* **Failover chain restarts.** When every backup model times out with no visible answer, the extension can restart the failover chain from the original model. You can configure how many extra passes are attempted with `nvidia-nim.fallback.maxChainRestarts` (available in VS Code Settings and `settings.json`, default 2).
* **Initial response timeout control.** Added `nvidia-nim.fallback.onFirstTokenTimeout` (default true). If disabled, long server queue delays or prompt prefill times will not switch to secondary models prematurely.
* **Extended timeout limits.** Stream idle timeout (`nvidia-nim.network.streamIdleTimeout`) and first response timeout (`nvidia-nim.fallback.firstTokenTimeoutSeconds`) now accept values up to 3600 seconds (1 hour) for complex reasoning tasks on large codebases.
* **Resilient agent turns.** If a model stalls after partially generating its response, the turn no longer fails with a stream timeout. The partial reply is preserved and the model is automatically nudged to continue.
* **Repetition protection.** Extended repetition detection catches runaway character and punctuation loops, and prevents reasoning streams from spinning endlessly behind the thinking spinner.
* **Cleaned and streamlined configuration.** Pruned redundant settings (`autoRepairArguments`, `autoRetryInvalidCalls`, `suppressDuplicateReads`, `autoCompactOnOverflow`, and individual fallback condition toggles) so core reliability features run unconditionally by default, leaving only essential controls for everyday customization.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.0.0.vsix` package.
