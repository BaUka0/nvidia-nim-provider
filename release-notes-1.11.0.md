# v1.11.0 — Agents window support

This release brings NVIDIA NIM models to VS Code's separate Agents window and makes bug reports more complete.

## New

* **NVIDIA NIM models in the Agents window.** On VS Code 1.145 or later, NVIDIA NIM models now show up in the model picker of Copilot sessions in the Agents window, alongside the regular chat view. No extra setup is needed. These sessions run through the Copilot harness, so they behave like Copilot sessions in the regular chat view; see Copilot vs Local Chat Sessions in the troubleshooting guide.

## Improvements

* **More complete bug reports.** `NVIDIA NIM: Save Last Turn Report` now includes your timeout, retry, and fallback settings, so a report no longer needs a follow-up question about them.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.11.0.vsix` package.
