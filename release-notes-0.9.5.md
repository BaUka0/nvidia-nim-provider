# v0.9.5 — Loop stop and Lightning back

This is a small hotfix. It stops one kind of stuck repeating paragraph, and it puts Nemotron 3.5 Lightning back in the model picker as a normal model.

## What changed for you

* **Repeating paragraphs.** If a model starts cycling the same paragraph with no line breaks, the extension stops that stream. By default it then nudges the model to keep working, instead of spinning until Copilot asks you to continue.
* **Lightning is back.** Nemotron 3.5 Lightning 30B no longer shows as Unavailable. It is a compact, fast option for everyday agentic turns. If the picker still shows the old Unavailable label, run **NVIDIA NIM: Refresh Models** from the Command Palette.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-0.9.5.vsix` package.
