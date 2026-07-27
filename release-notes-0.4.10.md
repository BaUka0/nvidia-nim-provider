# v0.4.10

## What's New

- **Automatic context-window recovery.** When NVIDIA NIM rejects a request with a server-reported context limit (HTTP 400), the extension now parses the exact limit, caches it for the model, compacts the conversation history, and retries once automatically. Subsequent requests use the discovered limit proactively, so long Copilot Chat sessions no longer fail repeatedly on the same overflow.
- **Fixed overflow parser bug.** The `"your messages resulted in N tokens"` error format previously mis-extracted the actual token count. Both the reported maximum and actual usage are now parsed correctly.
- **Retry-once guarantee.** Context-overflow compaction and retry now execute at most once per request, eliminating the possibility of a retry loop on persistent 400 responses.
- **Model-card output limits.** Aligned `maxOutputTokens` with model-card specifications for DeepSeek V4 Flash/Pro (131,072), GLM 5.2 (131,072), Step 3.7 Flash (262,144), and Laguna XS 2.1 (65,536).
- **Better error diagnostics.** Final context-overflow errors now include the model name, server-reported limit, and actual prompt token count.

## Install

Download the `nvidia-nim-agent-0.4.10.vsix` file and install it from the VS Code Extensions view using **Install from VSIX...**
