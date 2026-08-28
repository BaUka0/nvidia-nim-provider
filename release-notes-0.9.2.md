# v0.9.2 — Catalog hotfix

This hotfix keeps Copilot Chat working after NVIDIA NIM retired a listed model, and it retargets automatic backups away from overloaded endpoints.

## What changed for you

* **Step 3.7 Flash is gone.** NVIDIA NIM reached end of life for this model on 28 August 2026. It is no longer offered in the model picker, fallback settings, or summarization settings.
* **Retired models fail over.** If NVIDIA returns HTTP 410 Gone (the model was removed), the extension treats that like an unavailable model and switches to a backup instead of stopping the turn with a generic error.
* **New default backups.** Text requests and conversation summarization now fall back to Nemotron 3 Super 120B (1M context, everyday coding workhorse). Image-containing requests fall back to Muse Glimmer. MiniMax M3 remains in the picker but is no longer the automatic vision backup.
* **Lightning marked Unavailable.** Nemotron 3.5 Lightning 30B is still returned by NVIDIA NIM, but the picker shows it as Unavailable because the endpoint is currently overloaded. You can still select it if you want to retry.
* **Refresh the model list.** After updating, run NVIDIA NIM: Refresh Models so Copilot drops the retired catalog entry from cache.

## Also in this build

These reliability changes were already queued and ship in the same package:

* Streaming and failover are more bounded: one shared attempt budget, no recursive fallback, and retries no longer stack extra turns onto a failed request.
* Tool-call repair no longer invents file paths from chat text, and oversized stream lines are dropped instead of growing without limit.
* API keys are checked on save, and automatic Copilot group migration is skipped in untrusted workspaces.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.9.2.vsix` package.
