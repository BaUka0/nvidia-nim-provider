# v0.9.6 — Overload retry

This is a small hotfix. Overloaded NVIDIA replies no longer kill the Copilot turn.

## What changed for you

* **Overload no longer ends the turn.** If NVIDIA NIM is briefly overloaded, the extension retries the same model and then continues on the backup if needed. This still works when the model had already printed some text and then retried a bad tool call. You should see the reply continue instead of an error.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.9.6.vsix` package.
