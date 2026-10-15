# v1.8.0 — Retirement Countdown in the Model Picker

NVIDIA retires models on short notice, and until now the first sign was a failed request. This release shows the retirement date in the model picker ahead of time, so you can switch models before one stops answering.

## What changed for you

* **Retirement countdown.** When NVIDIA announces that a model will be retired, its name in the model picker shows how many days are left, for example "Nemotron 3 Super (retires in 3 days)". The count updates at midnight UTC. On the last day the name says "retires today", and after that it says "retired". In Local chat sessions, the model's details in the picker also show a warning with the exact date.
* **Two models are being retired.** NVIDIA retires Nemotron 3 Super on October 19, 2026, and GLM 5.3 on October 27, 2026. Pick another model before then. If one of them is your backup or summarization model, change it in the VS Code Settings UI or `settings.json`.
* **Model icons.** In Local chat sessions, NVIDIA NIM models show a lightning bolt icon in the model picker and on the model button, so they are easy to tell apart from other providers. Models that are about to be retired show a warning icon instead. Copilot sessions keep the default icon, because VS Code sets the icons there itself.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.8.0.vsix` package.
